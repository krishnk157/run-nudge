import { sql } from "@/db/client";

/**
 * Food identity and composition.
 *
 * The whole reproducibility claim of Day 7 rests on one rule: **the model may
 * propose what is in a food, once; it may never compute what is in a meal.**
 *
 * Composition has to come from somewhere, and for "the biryani my mother makes"
 * there is no database to look it up in — an estimate is the only option that
 * exists. But an estimate made once and stored is a fact you can correct; an
 * estimate made fresh on every question is a number that drifts. So the first
 * sighting of a food writes a row, and every later sighting reads it.
 */

export interface FoodComposition {
  kcalPer100g: number;
  proteinGPer100g: number;
  carbsGPer100g: number;
  fatGPer100g: number;
}

export interface FoodRow extends FoodComposition {
  id: number;
  key: string;
  name: string;
  source: "model" | "user";
}

/**
 * The identity of a food.
 *
 * Case and spacing are noise: "Chicken Biryani", "chicken biryani" and
 * "chicken  biryani" are one food. Anything more aggressive — stemming,
 * stripping adjectives — starts merging foods that genuinely differ, and
 * "grilled chicken" is not "fried chicken".
 */
export function foodKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Existing foods for a set of names, keyed by the normalized name. */
export async function findFoods(names: string[]): Promise<Map<string, FoodRow>> {
  const keys = [...new Set(names.map(foodKey))].filter(Boolean);
  if (keys.length === 0) return new Map();

  const rows = await sql<FoodRow[]>`
    select id, key, name,
           kcal_per_100g      as "kcalPer100g",
           protein_g_per_100g as "proteinGPer100g",
           carbs_g_per_100g   as "carbsGPer100g",
           fat_g_per_100g     as "fatGPer100g",
           source
    from foods
    where key = any(${keys})`;

  return new Map(rows.map((r) => [r.key, r]));
}

/**
 * Get the stored food, or create it from a proposed composition.
 *
 * `ON CONFLICT DO UPDATE` on the key rather than `DO NOTHING`, so the returned
 * row is always the canonical one — with `DO NOTHING` a concurrent insert
 * returns no row and the caller has to re-query to find out what won. The
 * update deliberately keeps the *stored* composition: a food the athlete has
 * already corrected must not be silently overwritten by a fresh model guess.
 */
export async function resolveFood(
  name: string,
  proposed: FoodComposition,
): Promise<FoodRow> {
  const key = foodKey(name);
  const [row] = await sql<FoodRow[]>`
    insert into foods
      (key, name, kcal_per_100g, protein_g_per_100g, carbs_g_per_100g,
       fat_g_per_100g, source)
    values
      (${key}, ${name.trim()}, ${proposed.kcalPer100g},
       ${proposed.proteinGPer100g}, ${proposed.carbsGPer100g},
       ${proposed.fatGPer100g}, 'model')
    on conflict (key) do update set key = excluded.key
    returning id, key, name,
      kcal_per_100g      as "kcalPer100g",
      protein_g_per_100g as "proteinGPer100g",
      carbs_g_per_100g   as "carbsGPer100g",
      fat_g_per_100g     as "fatGPer100g",
      source`;
  return row;
}

/**
 * Correct a food's composition. Marks it `user`, which is what stops a later
 * model proposal from ever taking precedence over it again.
 */
export async function correctFood(
  id: number,
  c: FoodComposition,
): Promise<void> {
  await sql`
    update foods set
      kcal_per_100g      = ${c.kcalPer100g},
      protein_g_per_100g = ${c.proteinGPer100g},
      carbs_g_per_100g   = ${c.carbsGPer100g},
      fat_g_per_100g     = ${c.fatGPer100g},
      source = 'user',
      updated_at = now()
    where id = ${id}`;
}
