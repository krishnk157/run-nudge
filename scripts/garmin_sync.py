"""Garmin Connect -> daily_metrics sync.

A Python sidecar, deliberately isolated: the Next.js app never imports this,
and this never imports the app. The two sides meet only at the daily_metrics
table. That boundary is the whole justification for adding a second language —
if this file ever needs to be in the request path, the design has gone wrong.

Why Python at all: Garmin has no official consumer API. The community
libraries that keep working are Python ones (garminconnect uses curl_cffi to
impersonate a browser's TLS fingerprint, which is how it gets past Garmin's bot
detection). The Node equivalent has not been published since Jan 2024 and
exposes no HRV, VO2max or training-load endpoints at all.

Usage:
    .venv/bin/python scripts/garmin_sync.py --days 30
    .venv/bin/python scripts/garmin_sync.py --since 2026-05-01
    .venv/bin/python scripts/garmin_sync.py --date 2026-07-26
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from typing import Any, Callable

import psycopg2
from dotenv import load_dotenv
from garminconnect import Garmin

load_dotenv()

TOKEN_STORE = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".garmin-tokens")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------

def connect() -> Garmin:
    """Log in, preferring cached tokens so we're not re-authenticating daily.

    Garmin rate-limits and eventually blocks repeated password logins, so the
    token cache isn't just a speed optimization — hammering the login endpoint
    is the fastest way to get an account temporarily locked out.

    `login(tokenstore)` does both halves itself: it loads cached tokens if the
    directory has usable ones (refreshing a nearly-expired session without
    touching the SSO endpoint), and dumps fresh tokens there after a password
    login. So there is exactly one call path, not a cache branch and a
    login branch that can drift apart.
    """
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    had_cache = os.path.isdir(TOKEN_STORE)

    if not had_cache and not (email and password):
        sys.exit(
            "GARMIN_EMAIL / GARMIN_PASSWORD not set in .env, and no token cache to fall back on."
        )

    # prompt_mfa is only invoked if the account actually has MFA enabled.
    client = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("Garmin MFA code: ").strip(),
    )
    client.login(TOKEN_STORE)
    print(f"authenticated ({'cached tokens' if had_cache else 'password'}); cache: {TOKEN_STORE}")
    return client


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def safe(label: str, fn: Callable[[], Any]) -> Any:
    """Call a Garmin endpoint, returning None instead of raising.

    Days the watch wasn't worn legitimately have no sleep, no HRV, no body
    battery. That is missing data, not failure, and one absent endpoint must
    not abort a multi-week backfill.
    """
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - unofficial API, failure modes are open-ended
        print(f"    {label}: unavailable ({type(e).__name__})")
        return None


def first_num(*values: Any) -> int | float | None:
    for v in values:
        if isinstance(v, (int, float)):
            return v
    return None


def fetch_day(client: Garmin, day: dt.date) -> dict[str, Any]:
    """All wellness endpoints for one calendar day, as raw payloads."""
    iso = day.isoformat()
    return {
        "sleep": safe("sleep", lambda: client.get_sleep_data(iso)),
        "hrv": safe("hrv", lambda: client.get_hrv_data(iso)),
        "rhr": safe("rhr", lambda: client.get_rhr_day(iso)),
        "max_metrics": safe("vo2max", lambda: client.get_max_metrics(iso)),
        "training_status": safe("training_status", lambda: client.get_training_status(iso)),
        "training_readiness": safe("training_readiness", lambda: client.get_training_readiness(iso)),
        "body_battery": safe("body_battery", lambda: client.get_body_battery(iso, iso)),
        "stress": safe("stress", lambda: client.get_stress_data(iso)),
        "steps": safe("steps", lambda: client.get_stats(iso)),
    }


# --------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------

def normalize(day: dt.date, raw: dict[str, Any]) -> dict[str, Any]:
    """Flatten Garmin's nested payloads into daily_metrics columns.

    Garmin's response shapes are undocumented and vary by device and firmware,
    so every access is defensive. The raw payloads are stored alongside, which
    is what makes that acceptable: if a field is mapped wrongly, the truth is
    still in the database and a fix is a migration, not a re-sync.
    """
    out: dict[str, Any] = {"date": day, "source": "garmin", "raw": json.dumps(raw)}

    sleep = (raw.get("sleep") or {}).get("dailySleepDTO") or {}
    out["sleep_seconds"] = sleep.get("sleepTimeSeconds")
    out["deep_sleep_seconds"] = sleep.get("deepSleepSeconds")
    out["light_sleep_seconds"] = sleep.get("lightSleepSeconds")
    out["rem_sleep_seconds"] = sleep.get("remSleepSeconds")
    out["awake_seconds"] = sleep.get("awakeSleepSeconds")
    scores = sleep.get("sleepScores") or {}
    out["sleep_score"] = (scores.get("overall") or {}).get("value")

    rhr = raw.get("rhr") or {}
    metrics = rhr.get("allMetrics", {}).get("metricsMap", {}) if isinstance(rhr, dict) else {}
    rhr_entries = metrics.get("WELLNESS_RESTING_HEART_RATE") or []
    out["resting_hr"] = first_num(
        rhr.get("restingHeartRate"),
        rhr_entries[0].get("value") if rhr_entries else None,
    )

    # HRV arrives under hrvSummary; baselines are what make the raw ms value
    # interpretable, so keep them rather than the number alone.
    hrv = (raw.get("hrv") or {}).get("hrvSummary") or {}
    out["hrv_last_night_avg_ms"] = hrv.get("lastNightAvg")
    out["hrv_last_night_high_ms"] = hrv.get("lastNight5MinHigh")
    out["hrv_status"] = hrv.get("status")
    baseline = hrv.get("baseline") or {}
    out["hrv_baseline_low_upper"] = baseline.get("lowUpper")
    out["hrv_baseline_balanced_low"] = baseline.get("balancedLow")
    out["hrv_baseline_balanced_upper"] = baseline.get("balancedUpper")

    # get_max_metrics returns a list; VO2max for running lives under generic.
    mm = raw.get("max_metrics")
    vo2 = None
    if isinstance(mm, list) and mm:
        vo2 = (mm[0].get("generic") or {}).get("vo2MaxPreciseValue") or (
            mm[0].get("generic") or {}
        ).get("vo2MaxValue")
    out["vo2max_running"] = vo2

    ts = raw.get("training_status") or {}
    latest = ts.get("mostRecentTrainingStatus") or {}
    dev_map = latest.get("latestTrainingStatusData") or {}
    status_entry = next(iter(dev_map.values()), {}) if isinstance(dev_map, dict) else {}
    out["training_status"] = status_entry.get("trainingStatusFeedbackPhrase") or status_entry.get(
        "trainingStatus"
    )
    load = ts.get("mostRecentTrainingLoadBalance") or {}
    load_map = load.get("metricsTrainingLoadBalanceDTOMap") or {}
    load_entry = next(iter(load_map.values()), {}) if isinstance(load_map, dict) else {}
    out["acute_training_load"] = load_entry.get("trainingLoadAcute")

    tr = raw.get("training_readiness")
    tr_entry = tr[0] if isinstance(tr, list) and tr else (tr if isinstance(tr, dict) else {})
    out["training_readiness_score"] = (tr_entry or {}).get("score")
    out["training_readiness_level"] = (tr_entry or {}).get("level")

    bb = raw.get("body_battery")
    bb_entry = bb[0] if isinstance(bb, list) and bb else {}
    out["body_battery_high"] = bb_entry.get("charged")
    out["body_battery_low"] = bb_entry.get("drained")

    stress = raw.get("stress") or {}
    out["average_stress"] = stress.get("avgStressLevel")

    stats = raw.get("steps") or {}
    out["steps"] = stats.get("totalSteps")

    return out


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------

COLUMNS = [
    "date", "source", "sleep_seconds", "deep_sleep_seconds", "light_sleep_seconds",
    "rem_sleep_seconds", "awake_seconds", "sleep_score", "resting_hr",
    "hrv_last_night_avg_ms", "hrv_last_night_high_ms", "hrv_status",
    "hrv_baseline_low_upper", "hrv_baseline_balanced_low", "hrv_baseline_balanced_upper",
    "vo2max_running", "training_status", "training_readiness_score",
    "training_readiness_level", "acute_training_load", "body_battery_high",
    "body_battery_low", "average_stress", "steps", "raw",
]


def upsert(conn, row: dict[str, Any]) -> None:
    """Same idempotency contract as the Strava ingest: re-running is safe."""
    placeholders = ", ".join(["%s"] * len(COLUMNS))
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c != "date")
    sql = (
        f'INSERT INTO daily_metrics ({", ".join(COLUMNS)}) VALUES ({placeholders}) '
        f"ON CONFLICT (date) DO UPDATE SET {updates}, fetched_at = now()"
    )
    with conn.cursor() as cur:
        cur.execute(sql, [row.get(c) for c in COLUMNS])


# --------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync Garmin daily metrics into Postgres")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--days", type=int, help="sync the last N days (default 7)")
    g.add_argument("--since", type=str, help="sync from this date to today (YYYY-MM-DD)")
    g.add_argument("--date", type=str, help="sync a single date (YYYY-MM-DD)")
    return p.parse_args()


def target_dates(args: argparse.Namespace) -> list[dt.date]:
    today = dt.date.today()
    if args.date:
        return [dt.date.fromisoformat(args.date)]
    if args.since:
        start = dt.date.fromisoformat(args.since)
        return [start + dt.timedelta(days=i) for i in range((today - start).days + 1)]
    days = args.days or 7
    return [today - dt.timedelta(days=i) for i in range(days - 1, -1, -1)]


def main() -> None:
    args = parse_args()
    dates = target_dates(args)

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        sys.exit("DATABASE_URL not set")

    client = connect()
    conn = psycopg2.connect(database_url)

    written = 0
    try:
        for day in dates:
            print(f"{day.isoformat()}:")
            raw = fetch_day(client, day)
            row = normalize(day, raw)
            upsert(conn, row)
            conn.commit()
            written += 1

            filled = [
                k for k in ("sleep_seconds", "hrv_last_night_avg_ms", "resting_hr",
                            "vo2max_running", "training_readiness_score", "steps")
                if row.get(k) is not None
            ]
            print(f"    stored; populated: {', '.join(filled) if filled else 'nothing'}")
    finally:
        conn.close()

    print(f"\nDone. {written} day(s) written to daily_metrics.")


if __name__ == "__main__":
    main()
