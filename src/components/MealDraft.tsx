"use client";

import { useState } from "react";

/**
 * The confirmation card: a proposed meal the athlete edits before it is saved.
 *
 * This exists because of a specific failure mode. A vision model reading a
 * plate is good at *what* and poor at *how much* — it will name the chicken
 * correctly and be 40% out on the portion. Saving straight from the proposal
 * would produce a food log that looks precise and drifts, and no one would
 * ever find out, because nothing downstream can tell an estimate from a
 * measurement.
 *
 * So grams are editable and everything else is not. That is the split the plan
 * predicted would matter, and it is also the friction risk: if this step is
 * what makes logging lapse, the retreat is save-immediately-edit-later, not
 * dropping the correction.
 */

export interface DraftItemSpec {
  name: string;
  grams: number;
  count?: string;
  composition: {
    kcalPer100g: number;
    proteinGPer100g: number;
    carbsGPer100g: number;
    fatGPer100g: number;
  };
  known: boolean;
  source: "model" | "user";
}

export interface MealDraftSpec {
  ok: boolean;
  eatenOn: string;
  loggedVia: "photo" | "text";
  note?: string;
  items: DraftItemSpec[];
}

interface SavedTotals {
  id: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  estimatedShare: number;
}

export function MealDraft({ spec }: { spec: MealDraftSpec }) {
  const [grams, setGrams] = useState(spec.items.map((i) => i.grams));
  const [saved, setSaved] = useState<SavedTotals | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Preview arithmetic, and the one place in the system that multiplies grams
   * by composition outside SQL.
   *
   * It is honest only because it uses the *same resolved compositions* the
   * server will use — the tool already substituted stored values for any food
   * the athlete has logged before — so preview and saved total agree by
   * construction rather than by luck. Once saved, the figure on screen is
   * replaced by the one SQL computed, so if they ever did disagree, the
   * database wins visibly.
   */
  const per = (pick: (c: DraftItemSpec["composition"]) => number) =>
    spec.items.reduce((a, it, i) => a + (pick(it.composition) * grams[i]) / 100, 0);

  const preview = {
    kcal: Math.round(per((c) => c.kcalPer100g)),
    proteinG: Math.round(per((c) => c.proteinGPer100g)),
    carbsG: Math.round(per((c) => c.carbsGPer100g)),
    fatG: Math.round(per((c) => c.fatGPer100g)),
  };

  const totals = saved ?? preview;
  const estimatedCount = spec.items.filter((i) => !i.known).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/meals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eatenOn: spec.eatenOn,
          loggedVia: spec.loggedVia,
          note: spec.note,
          items: spec.items.map((it, i) => ({
            name: it.name,
            grams: grams[i],
            count: it.count,
            composition: it.composition,
            // Recorded per item, so it is possible to ask later whether the
            // confirmation step is earning its friction.
            edited: grams[i] !== it.grams,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSaved(json.meal);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`meal ${saved ? "is-saved" : ""}`}>
      <div className="meal-head">
        <span className="lbl">
          {saved ? "Logged" : "Confirm meal"} · {spec.eatenOn}
          {spec.note ? ` · ${spec.note}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <span className="lbl meta">
          {spec.loggedVia === "photo" ? "from photo" : "from text"}
        </span>
      </div>

      <table className="meal-items">
        <tbody>
          {spec.items.map((it, i) => (
            <tr key={`${it.name}-${i}`}>
              <td>
                <div className="meal-name">{it.name}</div>
                <div className="meal-sub">
                  {it.count ? `${it.count} · ` : ""}
                  {it.known ? (
                    <span title="Composition already stored — this dish will produce the same numbers as last time.">
                      known food{it.source === "user" ? ", corrected" : ""}
                    </span>
                  ) : (
                    <span title="No stored composition; these figures are the model's estimate and become editable once saved.">
                      new · estimated
                    </span>
                  )}
                </div>
              </td>
              <td className="meal-grams">
                {saved ? (
                  <span className="num">{grams[i]} g</span>
                ) : (
                  <>
                    <input
                      className="ask-input num"
                      type="number"
                      min={1}
                      max={5000}
                      step={5}
                      value={grams[i]}
                      aria-label={`Grams of ${it.name}`}
                      onChange={(e) =>
                        setGrams((g) =>
                          g.map((v, j) =>
                            j === i ? Math.max(0, Number(e.target.value)) : v,
                          ),
                        )
                      }
                    />
                    <span className="meal-unit">g</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="meal-totals num">
        <b>{totals.kcal}</b> kcal · <b>{totals.proteinG}</b> g protein ·{" "}
        {totals.carbsG} c · {totals.fatG} f
        {!saved && <span className="meal-prov"> preview</span>}
      </div>

      {estimatedCount > 0 && (
        <div className="meal-prov">
          {estimatedCount} of {spec.items.length} item
          {spec.items.length === 1 ? "" : "s"} has no stored composition yet —
          those figures are estimates until you correct them.
        </div>
      )}

      {error && <div className="meal-err">{error}</div>}

      {!saved && (
        <div className="meal-actions">
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save meal"}
          </button>
        </div>
      )}
    </div>
  );
}
