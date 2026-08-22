import { z } from "zod";

import { startPhase } from "@/lib/nutrition/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Declaring a goal phase.
 *
 * A phase is recorded by its start date only — there is no "end phase" here,
 * because ending one is the same event as beginning the next. Offering both
 * would let the athlete describe a stretch of time that belongs to no phase,
 * and then every weight query has to decide what that means.
 */
const Body = z.object({
  phase: z.enum(["bulk", "cut", "maintain"]),
  startedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return Response.json(
      { error: "invalid phase", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const { phase, startedOn, note } = parsed.data;
  await startPhase(phase, startedOn, note);
  return Response.json({ ok: true });
}
