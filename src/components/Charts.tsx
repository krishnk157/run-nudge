import type { EfficiencyPoint, WeeklyPoint } from "@/lib/dashboard/data";

/**
 * Hand-rolled SVG rather than a charting library.
 *
 * The plan named Recharts, but the one property these charts must guarantee —
 * *never draw across a gap in a way that implies training happened* — is
 * exactly the thing a general-purpose library does for you by default. Bars
 * that show a zero, and a line that breaks rather than interpolating, are
 * easier to get right in 40 lines than to configure a library out of.
 */

const DAY = 86_400_000;

export function LoadBars({ weekly }: { weekly: WeeklyPoint[] }) {
  if (weekly.length === 0) return null;

  // Fill missing weeks: a week with no training must appear as a zero bar,
  // not vanish and let the neighbouring weeks sit next to each other as if
  // they were consecutive.
  const filled: WeeklyPoint[] = [];
  const first = new Date(`${weekly[0].weekStart}T00:00:00Z`).getTime();
  const last = new Date(`${weekly.at(-1)!.weekStart}T00:00:00Z`).getTime();
  const byWeek = new Map(weekly.map((w) => [w.weekStart, w]));
  for (let t = first; t <= last; t += 7 * DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    filled.push(
      byWeek.get(key) ?? {
        weekStart: key,
        load: 0,
        gymSessions: 0,
        runSessions: 0,
        hours: 0,
      },
    );
  }

  const max = Math.max(...filled.map((w) => w.load), 1);
  const bw = 300 / filled.length;

  return (
    <svg viewBox="0 0 300 74" role="img" aria-label="Weekly training load">
      <line x1="0" y1="73" x2="300" y2="73" stroke="var(--rule-strong)" strokeWidth="1" />
      {filled.map((w, i) => {
        const x = i * bw + 1.5;
        if (w.load === 0) {
          // A zero week is drawn, not skipped.
          return (
            <rect
              key={w.weekStart}
              x={x}
              y={69}
              width={Math.max(1, bw - 3)}
              height={4}
              fill="var(--dormant)"
              opacity={0.3}
            >
              <title>{`${w.weekStart}: no training`}</title>
            </rect>
          );
        }
        const h = Math.max(3, (w.load / max) * 62);
        return (
          <rect
            key={w.weekStart}
            x={x}
            y={73 - h}
            width={Math.max(1, bw - 3)}
            height={h}
            fill="var(--brand)"
          >
            <title>{`${w.weekStart}: load ${w.load} · ${w.gymSessions} gym, ${w.runSessions} run`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function EfficiencyChart({ points }: { points: EfficiencyPoint[] }) {
  if (points.length === 0) return null;

  const t0 = new Date(points[0].date).getTime();
  const span = Math.max(1, new Date(points.at(-1)!.date).getTime() - t0);
  const values = points.map((p) => p.index);
  const lo = Math.min(...values) * 0.97;
  const hi = Math.max(...values) * 1.03;

  const xs = (d: string) => 8 + ((new Date(d).getTime() - t0) / span) * 284;
  const ys = (v: number) => 66 - ((v - lo) / Math.max(1e-9, hi - lo)) * 54;

  // Join consecutive points only when they're close enough in time that a line
  // between them means something. A 36-day gap gets a dashed void instead —
  // the athlete did not train continuously between those runs.
  const GAP_DAYS = 21;
  const segments: EfficiencyPoint[][] = [];
  let current: EfficiencyPoint[] = [];
  points.forEach((p, i) => {
    if (i > 0) {
      const gap =
        (new Date(p.date).getTime() - new Date(points[i - 1].date).getTime()) / DAY;
      if (gap > GAP_DAYS) {
        segments.push(current);
        current = [];
      }
    }
    current.push(p);
  });
  segments.push(current);

  return (
    <svg viewBox="0 0 300 74" role="img" aria-label="Aerobic efficiency over time">
      <line x1="0" y1="73" x2="300" y2="73" stroke="var(--rule-strong)" strokeWidth="1" />
      {segments.map((seg, i) =>
        seg.length > 1 ? (
          <polyline
            key={`seg-${i}`}
            points={seg.map((p) => `${xs(p.date)},${ys(p.index)}`).join(" ")}
            fill="none"
            stroke="var(--brand)"
            strokeWidth="1.5"
            opacity={0.55}
          />
        ) : null,
      )}
      {segments.slice(0, -1).map((seg, i) => {
        const a = seg.at(-1);
        const b = segments[i + 1]?.[0];
        if (!a || !b) return null;
        return (
          <line
            key={`gap-${i}`}
            x1={xs(a.date)}
            y1={ys(a.index)}
            x2={xs(b.date)}
            y2={ys(b.index)}
            stroke="var(--dormant)"
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity={0.6}
          />
        );
      })}
      {points.map((p, i) => {
        const last = i === points.length - 1;
        return (
          <circle
            key={p.date}
            cx={xs(p.date)}
            cy={ys(p.index)}
            r={last ? 4 : 2.6}
            fill={last ? "var(--brand)" : "var(--surface)"}
            stroke="var(--brand)"
            strokeWidth="1.5"
          >
            <title>{`${p.date}: ${p.km} km at ${p.avgHr} bpm`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/** Chart rendered inside chat, from a `render_chart` tool call. */
export function ChatChart({
  spec,
}: {
  spec: { title: string; type: string; points: { x: string; y: number }[] };
}) {
  const pts = spec.points ?? [];
  if (pts.length === 0) return null;
  const max = Math.max(...pts.map((p) => p.y), 1);
  const min = Math.min(...pts.map((p) => p.y), 0);
  const range = Math.max(1e-9, max - min);
  const bw = 280 / pts.length;

  return (
    <div style={{ marginTop: 8 }}>
      <div className="lbl" style={{ marginBottom: 4 }}>{spec.title}</div>
      <svg viewBox="0 0 300 80" style={{ width: "100%", height: 80 }} role="img" aria-label={spec.title}>
        <line x1="0" y1="72" x2="300" y2="72" stroke="var(--rule-strong)" strokeWidth="1" />
        {spec.type === "bar"
          ? pts.map((p, i) => {
              const h = Math.max(2, ((p.y - min) / range) * 60);
              return (
                <rect
                  key={i}
                  x={i * bw + 10.5}
                  y={72 - h}
                  width={Math.max(1, bw - 3)}
                  height={h}
                  fill="var(--brand)"
                >
                  <title>{`${p.x}: ${p.y}`}</title>
                </rect>
              );
            })
          : (() => {
              const xs = (i: number) => 10 + (i / Math.max(1, pts.length - 1)) * 280;
              const ys = (v: number) => 66 - ((v - min) / range) * 56;
              return (
                <>
                  {spec.type === "line" && pts.length > 1 && (
                    <polyline
                      points={pts.map((p, i) => `${xs(i)},${ys(p.y)}`).join(" ")}
                      fill="none"
                      stroke="var(--brand)"
                      strokeWidth="1.5"
                      opacity={0.6}
                    />
                  )}
                  {pts.map((p, i) => (
                    <circle key={i} cx={xs(i)} cy={ys(p.y)} r="3" fill="var(--brand)">
                      <title>{`${p.x}: ${p.y}`}</title>
                    </circle>
                  ))}
                </>
              );
            })()}
      </svg>
      <div className="hint">
        {pts[0].x} → {pts.at(-1)!.x}
      </div>
    </div>
  );
}
