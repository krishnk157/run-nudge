import { z } from "zod";

import { deleteMeal, saveMeal } from "@/lib/nutrition/meals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saving a meal.
 *
 * Note what is *not* here: the chat model cannot reach this route. It proposes
 * a draft; a person presses a button; the browser posts it. Making the write a
 * plain HTTP endpoint rather than a tool means no prompt, no jailbreak and no
 * misread photo can put a row in the database on its own — the confirmation
 * step is structural, not a policy the model is asked to respect.
 *
 * The body is re-validated here even though the client just built it from a
 * tool result, because "the client is ours" stops being true the moment
 * anything else learns the URL.
 */
const Composition = z.object({
  kcalPer100g: z.number().nonnegative().max(900),
  proteinGPer100g: z.number().nonnegative().max(100),
  carbsGPer100g: z.number().nonnegative().max(100),
  fatGPer100g: z.number().nonnegative().max(100),
});

const Body = z.object({
  eatenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  loggedVia: z.enum(["photo", "text"]),
  rawInput: z.string().max(4000).optional(),
  note: z.string().max(200).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        // 5 kg of one food in a sitting is a typo, not a meal.
        grams: z.number().positive().max(5000),
        count: z.string().max(60).optional(),
        composition: Composition,
        edited: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(30),
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
      { error: "invalid meal", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const saved = await saveMeal(parsed.data);
    return Response.json({ ok: true, meal: saved });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "id required" }, { status: 400 });
  }
  await deleteMeal(id);
  return Response.json({ ok: true });
}
