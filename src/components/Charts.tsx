"use client";

import { useState } from "react";

import type {
  DayLoad,
  EfficiencyPoint,
  PacePoint,
  SeriesPoint,
  WeeklyPoint,
} from "@/lib/dashboard/data";
import type { WeightPoint } from "@/lib/nutrition/body";

/**
 * Hand-rolled SVG rather than a charting library.
 *
 * The plan named Recharts, but the one property these charts must guarantee —
 * *never draw across a gap in a way that implies training happened* — is
 * exactly the thing a general-purpose library does for you by default. Bars
 * that show a zero, and a line that breaks rather than interpolating, are
 * easier to get right by hand than to configure a library out of.
 *
 * What that cost, initially, was everything a library gives you for free:
 * these had no axes, no units and no readable tooltips, which made them
 * decoration rather than instruments — a shape with no way to find out what
 * any part of it meant. The frame below is the missing half.
 */

const DAY = 86_400_000;

/* ------------------------------------------------------------------ *
 * Frame geometry
 *
 * One coordinate system for every chart, so the axes line up between panels
 * and a reader learns the layout once. The left gutter holds y labels, the
 * bottom one holds dates; the plot is what remains.
 * ------------------------------------------------------------------ */
const W = 320;
const H = 112;
const PAD = { l: 36, r: 10, t: 10, b: 22 };
const PW = W - PAD.l - PAD.r;
const PH = H - PAD.t - PAD.b;
const X0 = PAD.l;
const Y0 = PAD.t + PH;

/**
 * "Nice" round tick values spanning lo..hi — 0, 25, 50 rather than 0, 23, 46.
 *
 * The top tick always covers `hi`, so no mark ever floats above the highest
 * labelled line. A bar taller than every gridline is a bar with no readable
 * value, which is the state these charts were in.
 */
function ticksFor(lo: number, hi: number, count = 3): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v < hi + step; v += step) out.push(Number(v.toFixed(6)));
  return out.length ? out : [lo];
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * Axes, gridlines and the fill gradient.
 *
 * The gridlines sit at the labelled values rather than at fixed pixel heights,
 * which is the difference between a grid you can measure against and one that
 * is only texture.
 */
function Frame({
  id,
  yTicks,
  ys,
  yFormat,
  xTicks,
  tint = "var(--brand)",
}: {
  id: string;
  yTicks: number[];
  ys: (v: number) => number;
  yFormat: (v: number) => string;
  xTicks: { x: number; label: string }[];
  tint?: string;
}) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tint} stopOpacity="0.22" />
          <stop offset="100%" stopColor={tint} stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((t) => (
        <g key={`y-${t}`}>
          <line
            x1={X0}
            y1={ys(t)}
            x2={X0 + PW}
            y2={ys(t)}
            stroke="var(--rule)"
            strokeWidth="0.5"
            opacity="0.7"
          />
          <text
            x={X0 - 5}
            y={ys(t) + 2.6}
            textAnchor="end"
            fontSize="7"
            fontFamily="var(--font-data)"
            fill="var(--ink-3)"
          >
            {yFormat(t)}
          </text>
        </g>
      ))}

      <line x1={X0} y1={Y0} x2={X0 + PW} y2={Y0} stroke="var(--rule-strong)" strokeWidth="1" />

      {xTicks.map((t, i) => (
        <text
          key={`x-${t.label}-${i}`}
          x={t.x}
          y={Y0 + 11}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
          fontSize="7"
          fontFamily="var(--font-data)"
          fill="var(--ink-3)"
        >
          {t.label}
        </text>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Tooltip
 *
 * A real element, not SVG <title>. Native titles wait a second, cannot be
 * styled, and — the reason they had to go — do not exist at all on touch,
 * which is where this dashboard is mostly read. Every mark below has a hit
 * area that responds to pointer *and* tap.
 * ------------------------------------------------------------------ */
interface Tip {
  x: number;
  y: number;
  head: string;
  lines: string[];
}

function useTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  return {
    tip,
    /**
     * stopPropagation matters: the whole chart is a click target that opens
     * chat with a question about it, and tapping a bar to read it should not
     * also launch a conversation.
     *
     * Both events have to be stopped. `pointerdown` and `click` are separate
     * events with separate propagation — stopping only pointerdown still let a
     * synthesised `click` bubble to the card, so on a phone every tap on a mark
     * popped the tooltip *and* threw the chat open. onClick is the one the card
     * actually listens on, so it is the one that has to be caught here.
     */
    bind: (t: Tip) => ({
      onPointerEnter: () => setTip(t),
      onPointerMove: () => setTip(t),
      onPointerLeave: () => setTip(null),
      onPointerDown: (e: React.PointerEvent) => {
        e.stopPropagation();
        setTip(t);
      },
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onFocus: () => setTip(t),
      onBlur: () => setTip(null),
      tabIndex: -1,
    }),
    clear: () => setTip(null),
  };
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  const left = (tip.x / W) * 100;
  const top = (tip.y / H) * 100;
  return (
    <div
      className="tip"
      style={{
        left: `${Math.min(78, Math.max(2, left))}%`,
        top: `${Math.max(0, top)}%`,
      }}
      role="status"
    >
      <b>{tip.head}</b>
      {tip.lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
}

/** Container that positions the tooltip over the plot. */
function Plot({
  label,
  children,
  tip,
  onLeave,
}: {
  label: string;
  children: React.ReactNode;
  tip: Tip | null;
  onLeave: () => void;
}) {
  return (
    <div className="plot" onPointerLeave={onLeave}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {children}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Fill missing weeks: a week with no training must appear as a zero, not
 * vanish and let the neighbouring weeks sit next to each other as if they
 * were consecutive. Shared by both bar charts so they cannot disagree about
 * which weeks exist.
 */
function fillWeeks(weekly: WeeklyPoint[]): WeeklyPoint[] {
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
  return filled;
}

/** Evenly spaced date labels across a categorical (bar) axis. */
function catTicks(items: { weekStart: string }[], bw: number) {
  const idx = [0, Math.floor((items.length - 1) / 2), items.length - 1].filter(
    (v, i, a) => a.indexOf(v) === i && v >= 0,
  );
  return idx.map((i) => ({
    x: X0 + i * bw + bw / 2,
    label: shortDate(items[i].weekStart),
  }));
}

/** Date labels across a continuous time axis. */
function timeTicks(t0: number, span: number) {
  return [0, 0.5, 1].map((f) => ({
    x: X0 + f * PW,
    label: shortDate(new Date(t0 + f * span).toISOString().slice(0, 10)),
  }));
}

export function LoadBars({ weekly }: { weekly: WeeklyPoint[] }) {
  const { tip, bind, clear } = useTip();
  if (weekly.length === 0) return null;

  const filled = fillWeeks(weekly);
  const max = Math.max(...filled.map((w) => w.load), 1);
  const yTicks = ticksFor(0, max);
  const top = Math.max(max, yTicks.at(-1) ?? max);
  const ys = (v: number) => Y0 - (v / top) * PH;
  const bw = PW / filled.length;

  return (
    <Plot label="Weekly training load" tip={tip} onLeave={clear}>
      <Frame
        id="load"
        yTicks={yTicks}
        ys={ys}
        yFormat={(v) => String(Math.round(v))}
        xTicks={catTicks(filled, bw)}
      />
      {filled.map((w, i) => {
        const x = X0 + i * bw + 1;
        const width = Math.max(1, bw - 2);
        const t: Tip = {
          x: x + width / 2,
          y: w.load === 0 ? Y0 - 12 : ys(w.load),
          head: `week of ${shortDate(w.weekStart)}`,
          lines:
            w.load === 0
              ? ["no training recorded"]
              : [
                  `load ${Math.round(w.load)}`,
                  `${w.gymSessions} gym · ${w.runSessions} run`,
                  `${w.hours} h moving`,
                ],
        };
        return (
          <g key={w.weekStart} {...bind(t)}>
            {/* Full-height hit area, so a zero week is as easy to interrogate
                as a tall one. */}
            <rect x={x} y={PAD.t} width={width} height={PH} fill="transparent" />
            {w.load === 0 ? (
              <rect x={x} y={Y0 - 3} width={width} height={3} fill="var(--dormant)" opacity={0.35} />
            ) : (
              <rect
                x={x}
                y={ys(w.load)}
                width={width}
                height={Y0 - ys(w.load)}
                fill="var(--brand)"
                opacity={0.85}
              />
            )}
          </g>
        );
      })}
    </Plot>
  );
}

/**
 * Modality mix per week — gym against runs.
 *
 * Stacked rather than side by side because the question is "what did the week
 * look like", and the total height is part of the answer.
 */
export function SportMix({ weekly }: { weekly: WeeklyPoint[] }) {
  const { tip, bind, clear } = useTip();
  if (weekly.length === 0) return null;

  const filled = fillWeeks(weekly);
  const max = Math.max(...filled.map((w) => w.gymSessions + w.runSessions), 1);
  const yTicks = ticksFor(0, max);
  const top = Math.max(max, yTicks.at(-1) ?? max);
  const ys = (v: number) => Y0 - (v / top) * PH;
  const bw = PW / filled.length;

  return (
    <Plot label="Sessions per week by sport" tip={tip} onLeave={clear}>
      <Frame
        id="mix"
        yTicks={yTicks}
        ys={ys}
        yFormat={(v) => String(Math.round(v))}
        xTicks={catTicks(filled, bw)}
      />
      {filled.map((w, i) => {
        const x = X0 + i * bw + 1;
        const width = Math.max(1, bw - 2);
        const total = w.gymSessions + w.runSessions;
        const gymH = Y0 - ys(w.gymSessions);
        const runH = Y0 - ys(w.runSessions);
        const t: Tip = {
          x: x + width / 2,
          y: total === 0 ? Y0 - 12 : ys(total),
          head: `week of ${shortDate(w.weekStart)}`,
          lines:
            total === 0
              ? ["nothing recorded"]
              : [`${w.gymSessions} gym`, `${w.runSessions} run`, `${w.hours} h moving`],
        };
        return (
          <g key={w.weekStart} {...bind(t)}>
            <rect x={x} y={PAD.t} width={width} height={PH} fill="transparent" />
            {total === 0 ? (
              <rect x={x} y={Y0 - 3} width={width} height={3} fill="var(--dormant)" opacity={0.35} />
            ) : (
              <>
                <rect x={x} y={Y0 - gymH} width={width} height={gymH} fill="var(--brand)" opacity={0.8} />
                <rect x={x} y={Y0 - gymH - runH} width={width} height={runH} fill="var(--ok)" opacity={0.85} />
              </>
            )}
          </g>
        );
      })}
    </Plot>
  );
}

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * Run pace over time. Scatter, never a line.
 *
 * Two runs six weeks apart joined by a line asserts a trajectory through a
 * period with no runs in it. The axis is inverted so up means faster, which
 * is what "improving" means to the person reading it — a chart where progress
 * points downward is misread at a glance every single time.
 */
export function PaceChart({ points }: { points: PacePoint[] }) {
  const { tip, bind, clear } = useTip();
  if (points.length === 0) return null;

  const t0 = new Date(points[0].date).getTime();
  const span = Math.max(1, new Date(points.at(-1)!.date).getTime() - t0);
  const vals = points.map((p) => p.secPerKm);
  const lo = Math.min(...vals) - 20;
  const hi = Math.max(...vals) + 20;

  const xs = (d: string) => X0 + ((new Date(d).getTime() - t0) / span) * PW;
  const ys = (v: number) => PAD.t + ((v - lo) / (hi - lo)) * PH;
  const best = points.reduce((a, b) => (b.secPerKm < a.secPerKm ? b : a));

  return (
    <Plot label="Run pace over time" tip={tip} onLeave={clear}>
      <Frame
        id="pace"
        yTicks={ticksFor(lo, hi)}
        ys={ys}
        yFormat={mmss}
        xTicks={timeTicks(t0, span)}
      />
      {points.map((p) => {
        const isBest = p === best;
        const t: Tip = {
          x: xs(p.date),
          y: ys(p.secPerKm),
          head: shortDate(p.date),
          lines: [`${p.km} km`, `${mmss(p.secPerKm)} /km`, ...(isBest ? ["fastest on file"] : [])],
        };
        return (
          <g key={`${p.date}-${p.km}`} {...bind(t)}>
            <circle cx={xs(p.date)} cy={ys(p.secPerKm)} r="7" fill="transparent" />
            <circle
              cx={xs(p.date)}
              cy={ys(p.secPerKm)}
              // Distance carries as radius: a fast 2 km and a fast 10 km are
              // not the same achievement, and hiding that flatters the short.
              r={Math.min(5, 1.8 + p.km * 0.3)}
              fill={isBest ? "var(--brand)" : "var(--surface)"}
              stroke={isBest ? "var(--brand)" : "var(--ink-3)"}
              strokeWidth="1.3"
            />
          </g>
        );
      })}
    </Plot>
  );
}

export function EfficiencyChart({ points }: { points: EfficiencyPoint[] }) {
  const { tip, bind, clear } = useTip();
  if (points.length === 0) return null;

  const t0 = new Date(points[0].date).getTime();
  const span = Math.max(1, new Date(points.at(-1)!.date).getTime() - t0);
  const values = points.map((p) => p.index * 1000);
  const lo = Math.min(...values) * 0.97;
  const hi = Math.max(...values) * 1.03;

  const xs = (d: string) => X0 + ((new Date(d).getTime() - t0) / span) * PW;
  const ys = (v: number) => Y0 - ((v - lo) / Math.max(1e-9, hi - lo)) * PH;

  // Join consecutive points only when they are close enough in time that a
  // line between them means something. A 36-day gap gets a dashed void.
  const GAP_DAYS = 21;
  const segments: EfficiencyPoint[][] = [];
  let current: EfficiencyPoint[] = [];
  points.forEach((p, i) => {
    if (i > 0) {
      const gap = (new Date(p.date).getTime() - new Date(points[i - 1].date).getTime()) / DAY;
      if (gap > GAP_DAYS) {
        segments.push(current);
        current = [];
      }
    }
    current.push(p);
  });
  segments.push(current);

  return (
    <Plot label="Aerobic efficiency over time" tip={tip} onLeave={clear}>
      <Frame
        id="eff"
        yTicks={ticksFor(lo, hi)}
        ys={ys}
        yFormat={(v) => v.toFixed(2)}
        xTicks={timeTicks(t0, span)}
      />

      {segments.map((seg, i) =>
        seg.length > 1 ? (
          <polygon
            key={`fill-${i}`}
            points={[
              `${xs(seg[0].date)},${Y0}`,
              ...seg.map((p) => `${xs(p.date)},${ys(p.index * 1000)}`),
              `${xs(seg.at(-1)!.date)},${Y0}`,
            ].join(" ")}
            fill="url(#eff-fill)"
          />
        ) : null,
      )}

      {segments.map((seg, i) =>
        seg.length > 1 ? (
          <polyline
            className="draw"
            key={`seg-${i}`}
            pathLength={1}
            points={seg.map((p) => `${xs(p.date)},${ys(p.index * 1000)}`).join(" ")}
            fill="none"
            stroke="var(--brand)"
            strokeWidth="1.75"
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
            y1={ys(a.index * 1000)}
            x2={xs(b.date)}
            y2={ys(b.index * 1000)}
            stroke="var(--dormant)"
            strokeWidth="1"
            strokeDasharray="2 4"
            opacity={0.6}
          />
        );
      })}

      {points.map((p, i) => {
        const last = i === points.length - 1;
        const t: Tip = {
          x: xs(p.date),
          y: ys(p.index * 1000),
          head: shortDate(p.date),
          lines: [`${(p.index * 1000).toFixed(2)} m/s per bpm`, `${p.km} km at ${p.avgHr} bpm`],
        };
        return (
          <g key={p.date} {...bind(t)}>
            <circle cx={xs(p.date)} cy={ys(p.index * 1000)} r="7" fill="transparent" />
            <circle
              cx={xs(p.date)}
              cy={ys(p.index * 1000)}
              r={last ? 4 : 2.6}
              fill={last ? "var(--brand)" : "var(--surface)"}
              stroke="var(--brand)"
              strokeWidth="1.5"
            />
          </g>
        );
      })}
    </Plot>
  );
}

/**
 * Weight, broken at every phase boundary.
 *
 * The line is deliberately not continuous across a change of goal. A single
 * sweep through a bulk and the cut that follows averages two opposite
 * intentions into one meaningless direction.
 */
export function WeightChart({ points }: { points: WeightPoint[] }) {
  const { tip, bind, clear } = useTip();
  if (points.length === 0) return null;

  const t0 = new Date(points[0].date).getTime();
  const span = Math.max(1, new Date(points.at(-1)!.date).getTime() - t0);
  const values = points.map((p) => p.weightKg);
  const lo = Math.min(...values) - 0.6;
  const hi = Math.max(...values) + 0.6;

  const xs = (d: string) => X0 + ((new Date(d).getTime() - t0) / span) * PW;
  const ys = (v: number) => Y0 - ((v - lo) / Math.max(1e-9, hi - lo)) * PH;

  const segments: WeightPoint[][] = [];
  let current: WeightPoint[] = [];
  points.forEach((p, i) => {
    if (i > 0 && p.phase !== points[i - 1].phase) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  });
  segments.push(current);

  const colour = (phase: WeightPoint["phase"]) =>
    phase === "bulk"
      ? "var(--ok)"
      : phase === "cut"
        ? "var(--warn)"
        : phase === "maintain"
          ? "var(--brand)"
          : "var(--dormant)";

  return (
    <Plot label="Body weight by goal phase" tip={tip} onLeave={clear}>
      <Frame
        id="wt"
        yTicks={ticksFor(lo, hi)}
        ys={ys}
        yFormat={(v) => v.toFixed(1)}
        xTicks={timeTicks(t0, span)}
      />

      {segments.slice(1).map((seg) => {
        const at = seg[0];
        return (
          <line
            key={`bound-${at.date}`}
            x1={xs(at.date)}
            y1={PAD.t}
            x2={xs(at.date)}
            y2={Y0}
            stroke="var(--rule-strong)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
        );
      })}

      {segments.map((seg, i) =>
        seg.length > 1 ? (
          <polyline
            className="draw"
            key={`wseg-${i}`}
            pathLength={1}
            points={seg.map((p) => `${xs(p.date)},${ys(p.weightKg)}`).join(" ")}
            fill="none"
            stroke={colour(seg[0].phase)}
            strokeWidth="1.75"
          />
        ) : null,
      )}

      {points.map((p, i) => {
        const t: Tip = {
          x: xs(p.date),
          y: ys(p.weightKg),
          head: shortDate(p.date),
          lines: [`${p.weightKg} kg`, p.phase ?? "no phase declared"],
        };
        return (
          <g key={p.date} {...bind(t)}>
            <circle cx={xs(p.date)} cy={ys(p.weightKg)} r="7" fill="transparent" />
            <circle
              cx={xs(p.date)}
              cy={ys(p.weightKg)}
              r={i === points.length - 1 ? 3.6 : 2.2}
              fill={i === points.length - 1 ? colour(p.phase) : "var(--surface)"}
              stroke={colour(p.phase)}
              strokeWidth="1.4"
            />
          </g>
        );
      })}
    </Plot>
  );
}

/**
 * A sparse measure over time — VO2max, and anything else the watch reports on
 * the days it was worn.
 *
 * Points only, plus a shaded region for how long the series has been silent.
 * Joining eleven days in May to nothing since would draw a confident flat line
 * across three months of no measurement.
 */
export function SparseSeries({
  points,
  label,
  today,
  unit = "",
  decimals = 1,
}: {
  points: SeriesPoint[];
  label: string;
  /** The athlete's date, from the server. Rendering must be pure, and their
   *  clock is the one that matters anyway. */
  today: string;
  unit?: string;
  decimals?: number;
}) {
  const { tip, bind, clear } = useTip();
  if (points.length === 0) return null;

  const t0 = new Date(points[0].date).getTime();
  // The axis runs to *today*, not to the last reading, so a series that
  // stopped months ago visibly stopped months ago.
  const now = new Date(`${today}T00:00:00Z`).getTime();
  const span = Math.max(1, now - t0);
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals) - 1;
  const hi = Math.max(...vals) + 1;

  const xs = (t: number) => X0 + ((t - t0) / span) * PW;
  const ys = (v: number) => Y0 - ((v - lo) / Math.max(1e-9, hi - lo)) * PH;
  const lastT = new Date(points.at(-1)!.date).getTime();
  const staleDays = Math.round((now - lastT) / DAY);

  return (
    <Plot label={label} tip={tip} onLeave={clear}>
      <Frame
        id="sparse"
        yTicks={ticksFor(lo, hi)}
        ys={ys}
        yFormat={(v) => v.toFixed(decimals)}
        xTicks={timeTicks(t0, span)}
      />

      {staleDays > 7 && (
        <g>
          <rect
            x={xs(lastT)}
            y={PAD.t}
            width={X0 + PW - xs(lastT)}
            height={PH}
            fill="var(--dormant)"
            opacity={0.08}
          />
          <line
            x1={xs(lastT)}
            y1={PAD.t}
            x2={xs(lastT)}
            y2={Y0}
            stroke="var(--dormant)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
          <text
            x={Math.min(X0 + PW - 2, xs(lastT) + 4)}
            y={PAD.t + 8}
            fill="var(--dormant)"
            fontSize="7"
            fontFamily="var(--font-data)"
          >
            {`${staleDays}d unmeasured`}
          </text>
        </g>
      )}

      {points.map((p) => {
        const t: Tip = {
          x: xs(new Date(p.date).getTime()),
          y: ys(p.value),
          head: shortDate(p.date),
          lines: [`${p.value.toFixed(decimals)}${unit ? ` ${unit}` : ""}`],
        };
        return (
          <g key={p.date} {...bind(t)}>
            <circle cx={xs(new Date(p.date).getTime())} cy={ys(p.value)} r="7" fill="transparent" />
            <circle
              cx={xs(new Date(p.date).getTime())}
              cy={ys(p.value)}
              r="2.6"
              fill="var(--surface)"
              stroke="var(--brand)"
              strokeWidth="1.4"
            />
          </g>
        );
      })}
    </Plot>
  );
}

/**
 * Twelve weeks of training, one cell per day.
 *
 * The densest honest view of consistency there is. An untrained day is an
 * empty outlined cell rather than a missing one, so a fortnight off is a
 * visible block of nothing instead of a gap the eye closes up.
 */
export function TrainingCalendar({ days, today }: { days: DayLoad[]; today: string }) {
  const { tip, bind, clear } = useTip();
  const WEEKS = 12;
  const byDay = new Map(days.map((d) => [d.date, d]));
  const max = Math.max(...days.map((d) => d.load), 1);

  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + ((7 - ((end.getUTCDay() + 6) % 7)) % 7));

  const cells: { date: string; d: DayLoad | undefined; col: number; row: number }[] = [];
  for (let i = WEEKS * 7 - 1; i >= 0; i--) {
    const t = new Date(end);
    t.setUTCDate(end.getUTCDate() - i);
    const key = t.toISOString().slice(0, 10);
    const idx = WEEKS * 7 - 1 - i;
    cells.push({ date: key, d: byDay.get(key), col: Math.floor(idx / 7), row: idx % 7 });
  }

  const LEFT = 16;
  const size = (W - LEFT - 6) / WEEKS;
  const cell = size - 2;
  const DOW = ["M", "T", "W", "T", "F", "S", "S"];
  const monthLabels: { x: number; label: string }[] = [];
  let lastMonth = "";
  for (const c of cells) {
    if (c.row !== 0) continue;
    const m = c.date.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      monthLabels.push({
        x: LEFT + c.col * size,
        label: new Date(`${c.date}T00:00:00Z`).toLocaleDateString("en-GB", {
          month: "short",
          timeZone: "UTC",
        }),
      });
    }
  }

  return (
    <div className="plot" onPointerLeave={clear}>
      <svg viewBox={`0 0 ${W} ${7 * size + 20}`} role="img" aria-label="Training calendar, last 12 weeks">
        {monthLabels.map((m) => (
          <text
            key={m.label + m.x}
            x={m.x}
            y="7"
            fontSize="7"
            fontFamily="var(--font-data)"
            fill="var(--ink-3)"
          >
            {m.label}
          </text>
        ))}
        {DOW.map((d, r) =>
          r % 2 === 0 ? (
            <text
              key={`dow-${r}`}
              x="0"
              y={12 + r * size + size * 0.68}
              fontSize="6.5"
              fontFamily="var(--font-data)"
              fill="var(--ink-3)"
            >
              {d}
            </text>
          ) : null,
        )}
        {cells.map((c) => {
          const load = c.d?.load ?? 0;
          const isFuture = c.date > today;
          const t: Tip = {
            x: LEFT + c.col * size,
            y: 12 + c.row * size,
            head: shortDate(c.date),
            lines: isFuture
              ? ["yet to come"]
              : load > 0
                ? [`${c.d!.sessions} session${c.d!.sessions === 1 ? "" : "s"}`, `load ${load}`]
                : ["nothing recorded"],
          };
          return (
            <rect
              key={c.date}
              {...bind(t)}
              x={LEFT + c.col * size + 1}
              y={12 + c.row * size + 1}
              width={cell}
              height={cell}
              fill={load > 0 ? "var(--brand)" : "transparent"}
              fillOpacity={load > 0 ? 0.22 + (load / max) * 0.78 : 0}
              stroke={isFuture ? "transparent" : "var(--rule)"}
              strokeWidth="0.6"
            />
          );
        })}
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/**
 * Chart rendered inside chat, from a `render_chart` tool call.
 *
 * Same frame as the dashboard's, deliberately: a chart the model draws should
 * be as readable — and as labelled — as one that was written by hand, or the
 * chat becomes the place where standards slip.
 */
export function ChatChart({
  spec,
}: {
  spec: {
    title: string;
    type: "bar" | "line" | "scatter";
    xLabel?: string;
    yLabel?: string;
    points: { x: string; y: number }[];
  };
}) {
  const { tip, bind, clear } = useTip();
  if (!spec.points?.length) return null;

  const vals = spec.points.map((p) => p.y);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  // Bars are only honest from zero; a line may start at its own floor.
  const lo = spec.type === "bar" ? 0 : min - (max - min) * 0.12 - 1e-6;
  const hi = max + (max - min) * 0.1 || max || 1;
  const yTicks = ticksFor(lo, hi);
  const topTick = Math.max(hi, yTicks.at(-1) ?? hi);
  const ys = (v: number) => Y0 - ((v - lo) / Math.max(1e-9, topTick - lo)) * PH;

  const n = spec.points.length;
  const bw = PW / n;
  const px = (i: number) =>
    spec.type === "bar" ? X0 + i * bw + bw / 2 : X0 + (n === 1 ? PW / 2 : (i / (n - 1)) * PW);

  const fmt = (v: number) =>
    Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(Math.abs(v) < 10 ? 1 : 0);

  const idx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const xTicks = idx.map((i) => ({
    x: px(i),
    label: /^\d{4}-\d{2}-\d{2}$/.test(spec.points[i].x)
      ? shortDate(spec.points[i].x)
      : spec.points[i].x,
  }));

  return (
    <figure className="chat-chart">
      <figcaption>{spec.title}</figcaption>
      <div className="plot" onPointerLeave={clear}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title}>
          <Frame id="chat" yTicks={yTicks} ys={ys} yFormat={fmt} xTicks={xTicks} />

          {spec.type === "line" && n > 1 && (
            <polyline
              className="draw"
              pathLength={1}
              points={spec.points.map((p, i) => `${px(i)},${ys(p.y)}`).join(" ")}
              fill="none"
              stroke="var(--brand)"
              strokeWidth="1.75"
            />
          )}

          {spec.points.map((p, i) => {
            const t: Tip = {
              x: px(i),
              y: ys(p.y),
              head: /^\d{4}-\d{2}-\d{2}$/.test(p.x) ? shortDate(p.x) : p.x,
              lines: [`${fmt(p.y)}${spec.yLabel ? ` ${spec.yLabel}` : ""}`],
            };
            if (spec.type === "bar") {
              return (
                <g key={`${p.x}-${i}`} {...bind(t)}>
                  <rect x={X0 + i * bw} y={PAD.t} width={bw} height={PH} fill="transparent" />
                  <rect
                    x={X0 + i * bw + 1}
                    y={ys(p.y)}
                    width={Math.max(1, bw - 2)}
                    height={Math.max(0, Y0 - ys(p.y))}
                    fill="var(--brand)"
                    opacity={0.85}
                  />
                </g>
              );
            }
            return (
              <g key={`${p.x}-${i}`} {...bind(t)}>
                <circle cx={px(i)} cy={ys(p.y)} r="7" fill="transparent" />
                <circle
                  cx={px(i)}
                  cy={ys(p.y)}
                  r="2.6"
                  fill="var(--surface)"
                  stroke="var(--brand)"
                  strokeWidth="1.4"
                />
              </g>
            );
          })}
        </svg>
        <TipBox tip={tip} />
      </div>
      {(spec.yLabel || spec.xLabel) && (
        <div className="chat-chart-axes">
          {spec.yLabel && <span>y: {spec.yLabel}</span>}
          {spec.xLabel && <span>x: {spec.xLabel}</span>}
        </div>
      )}
    </figure>
  );
}
