import { z } from "zod";

import { logWeight, setHeightCm } from "@/lib/nutrition/body";
import { athleteToday } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Weight and height, from the dashboard form.
 *
 * Bounds are wide on purpose. They exist to catch a slipped decimal point or
 * a pounds-for-kilograms mix-up, which are silent and corrupt every trend
 * downstream — not to police what a plausible bodyweight is.
 */
const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weightKg: z.number().min(25).max(300).optional(),
  heightCm: z.number().min(100).max(250).optional(),
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
      { error: "invalid body log", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const { date, weightKg, heightCm, note } = parsed.data;
  if (weightKg == null && heightCm == null) {
    return Response.json({ error: "nothing to record" }, { status: 400 });
  }

  if (heightCm != null) await setHeightCm(heightCm);
  if (weightKg != null) {
    // The athlete's date, not the server's: a weigh-in posted at 00:10
    // local would otherwise land on yesterday and overwrite it.
    await logWeight(date ?? (await athleteToday()), weightKg, note);
  }
  return Response.json({ ok: true });
}
