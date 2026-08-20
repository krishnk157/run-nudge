"use client";

import type { ReactNode } from "react";

import { EfficiencyChart as EfficiencySvg, LoadBars as LoadBarsSvg } from "./Charts";
import type { EfficiencyPoint, WeeklyPoint } from "@/lib/dashboard/data";

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
}: {
  question: string;
  children: ReactNode;
}) {
  return (
    <div
      className="chart"
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
