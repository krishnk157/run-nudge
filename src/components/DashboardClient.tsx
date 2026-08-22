"use client";

import type { ReactNode } from "react";

import {
  EfficiencyChart as EfficiencySvg,
  LoadBars as LoadBarsSvg,
  PaceChart as PaceSvg,
  SparseSeries as SparseSvg,
  SportMix as SportMixSvg,
  TrainingCalendar as CalendarSvg,
  WeightChart as WeightSvg,
} from "./Charts";
import type {
  DayLoad,
  EfficiencyPoint,
  PacePoint,
  SeriesPoint,
  WeeklyPoint,
} from "@/lib/dashboard/data";
import type { WeightPoint } from "@/lib/nutrition/body";

/**
 * Client wrappers. The charts themselves are pure SVG and could render on the
 * server, but they carry `<title>` tooltips and sit inside click-to-ask
 * containers, so they live on the client alongside the panel that opens.
 */

export function LoadBars({ weekly }: { weekly: WeeklyPoint[] }) {
  return <LoadBarsSvg weekly={weekly} />;
}

export function EfficiencyChart({ points }: { points: EfficiencyPoint[] }) {
  return <EfficiencySvg points={points} />;
}

export function WeightChart({ points }: { points: WeightPoint[] }) {
  return <WeightSvg points={points} />;
}

export function SportMix({ weekly }: { weekly: WeeklyPoint[] }) {
  return <SportMixSvg weekly={weekly} />;
}

export function PaceChart({ points }: { points: PacePoint[] }) {
  return <PaceSvg points={points} />;
}

export function SparseSeries(props: {
  points: SeriesPoint[];
  label: string;
  today: string;
  decimals?: number;
}) {
  return <SparseSvg {...props} />;
}

export function TrainingCalendar(props: { days: DayLoad[]; today: string }) {
  return <CalendarSvg {...props} />;
}

/**
 * A chart that seeds the chat with a question about itself.
 *
 * This is where chat stops being a search box you have to remember exists:
 * you're looking at a shape you don't understand, and the question is one
 * click away with its context already filled in.
 */
export function AskLink({
  question,
  children,
  wide,
}: {
  question: string;
  children: ReactNode;
  /** Span the full grid — for charts that need the width, like the calendar. */
  wide?: boolean;
}) {
  return (
    <div
      className={`chart ${wide ? "chart-wide" : ""}`}
      role="button"
      tabIndex={0}
      style={{ cursor: "pointer" }}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent("runnudge:ask", { detail: question }),
        )
      }
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          window.dispatchEvent(
            new CustomEvent("runnudge:ask", { detail: question }),
          );
        }
      }}
      aria-label={`Ask: ${question}`}
    >
      {children}
    </div>
  );
}
