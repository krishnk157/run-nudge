"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { PhaseSpan } from "@/lib/nutrition/body";

/**
 * Logging weight, and declaring a phase.
 *
 * Two forms rather than one, because they are different kinds of act. A
 * weigh-in is a measurement you take most mornings; a phase change is a
 * decision you make a few times a year. Putting them in one form invites
 * declaring a phase by accident, and a stray phase boundary silently splits
 * every trend that crosses it.
 */
export function BodyForm({
  latestKg,
  latestOn,
  phase,
}: {
  latestKg: number | null;
  latestOn: string | null;
  phase: PhaseSpan | null;
}) {
  const router = useRouter();
  // Correct here, unlike on the server: this runs in the athlete's browser,
  // so local time is their clock. `toISOString` would be UTC, so build the
  // date from the local parts instead — en-CA formats as YYYY-MM-DD.
  const today = new Date().toLocaleDateString("en-CA");

  const [kg, setKg] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phaseOpen, setPhaseOpen] = useState(false);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setKg("");
      setPhaseOpen(false);
      // The dashboard is server-rendered, so a save has to re-fetch it rather
      // than patch local state — which also means what you see afterwards came
      // back out of the database, not out of the form you just filled in.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="body-form">
      <form
        className="body-row"
        onSubmit={(e) => {
          e.preventDefault();
          const value = Number(kg);
          if (!Number.isFinite(value) || value <= 0) return;
          void post("/api/body", { date: today, weightKg: value });
        }}
      >
        <label className="lbl" htmlFor="weight-kg">
          Weigh in
        </label>
        <input
          id="weight-kg"
          className="ask-input num"
          type="number"
          step="0.1"
          min="25"
          max="300"
          inputMode="decimal"
          placeholder={latestKg ? String(latestKg) : "kg"}
          value={kg}
          onChange={(e) => setKg(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || !kg}>
          Log
        </button>
        <span className="lbl meta">
          {latestOn ? `last ${latestKg} kg on ${latestOn}` : "nothing logged yet"}
        </span>
      </form>

      <div className="body-row">
        <span className="lbl">Phase</span>
        <span className="phase-now num">
          {phase ? `${phase.phase} since ${phase.startedOn}` : "none declared"}
        </span>
        <button
          className="btn"
          onClick={() => setPhaseOpen((v) => !v)}
          aria-expanded={phaseOpen}
        >
          {phaseOpen ? "Cancel" : "Change"}
        </button>
      </div>

      {phaseOpen && (
        <form
          className="body-row"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void post("/api/phases", {
              phase: data.get("phase"),
              startedOn: data.get("startedOn"),
            });
          }}
        >
          <select className="ask-input" name="phase" defaultValue="bulk">
            <option value="bulk">bulk</option>
            <option value="cut">cut</option>
            <option value="maintain">maintain</option>
          </select>
          <input
            className="ask-input num"
            type="date"
            name="startedOn"
            defaultValue={today}
            required
          />
          <button className="btn" type="submit" disabled={busy}>
            Start
          </button>
          <span className="lbl meta">
            a phase runs until the next one begins
          </span>
        </form>
      )}

      {error && <div className="meal-err">{error}</div>}
    </div>
  );
}
