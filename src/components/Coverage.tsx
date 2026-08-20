"use client";

import { useState } from "react";

import type { Finding } from "@/lib/analysis/types";

/**
 * The coverage panel — the piece that makes silence legible.
 *
 * Without it, "no recovery flags this week" is ambiguous between *you're
 * fine* and *the watch wasn't worn*. Each dormant rule states its own unlock
 * condition, which also turns the sparse data from an embarrassment into a
 * progress bar.
 */

const RULE_NAMES: Record<string, string> = {
  acute_chronic_ratio: "Acute : chronic workload",
  consistency: "Consistency & streaks",
  aerobic_efficiency_trend: "Aerobic efficiency trend",
  resting_hr_drift: "Resting heart rate drift",
  strength_progression: "Strength progression",
};

export function Coverage({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState(false);

  const active = findings.filter((f) => f.status !== "ineligible" && f.status !== "error");
  const errored = findings.filter((f) => f.status === "error");
  const dormant = findings.filter((f) => f.status === "ineligible");

  return (
    <section>
      <button
        className="cov-bar"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cov-dots" aria-hidden="true">
          {findings.map((f, i) => (
            <span
              key={i}
              className={`cov-dot ${f.status === "ineligible" ? "off" : ""}`}
            />
          ))}
        </span>
        <span className="cov-txt">
          {active.length} of {findings.length} insights active
          {dormant.length > 0 && ` — ${dormant.length} dormant for want of data`}
          {errored.length > 0 && ` · ${errored.length} errored`}
        </span>
        <span className="cov-toggle">{open ? "hide ▴" : "why ▾"}</span>
      </button>

      {open && (
        <div className="cov">
          <div className="cov-body">
            {findings.map((f, i) => {
              const off = f.status === "ineligible";
              const err = f.status === "error";
              return (
                <div className={`rule-row ${off ? "off" : ""}`} key={i}>
                  <span className={`rule-mark ${off ? "off" : ""} ${err ? "err" : ""}`} />
                  <span className="rule-name">
                    {RULE_NAMES[f.rule] ?? f.rule.replace(/_/g, " ")}
                  </span>
                  <span className="rule-why">
                    {err
                      ? "rule failed to evaluate"
                      : off
                        ? (f.eligibility.reason ?? "no data")
                        : f.status === "fired"
                          ? "firing"
                          : "evaluated, nothing to report"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
