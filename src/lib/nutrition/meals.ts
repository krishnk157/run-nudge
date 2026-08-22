import { sql } from "@/db/client";
import { resolveFood, type FoodComposition, type FoodRow } from "./foods";

/**
 * Saving meals, and totalling them.
 *
 * Every number a person ever sees on this page is produced by the SQL in this
 * file. Nothing multiplies grams by composition in JavaScript, and nothing
 * asks the model what a meal "comes to" — that is the difference between a
 * food log and a plausible-sounding one.
 */

export interface DraftItem {
  name: string;
  grams: number;
  /** Display text only ("2 eggs"). Never enters a calculation. */
  count?: string;
  composition: FoodComposition;
  /** True when the athlete changed the proposed grams before saving. */
  edited?: boolean;
}

export interface MealDraft {
  eatenOn: string;
  loggedVia: "photo" | "text";
  rawInput?: string;
  note?: string;
  items: DraftItem[];
}

export interface MealTotals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** Share of calories from compositions the model proposed and nobody checked. */
  estimatedShare: number;
}

export interface SavedMeal extends MealTotals {
  id: number;
  eatenOn: string;
  itemCount: number;
}

/**
 * Write a confirmed draft.
 *
 * Two phases, in this order for two different reasons.
 *
 * Foods are resolved *first, outside the transaction*, because a food is
 * shared reference data: learning what is in chicken biryani is not part of
 * this eating occasion, and it should survive even if this meal is rolled
 * back. (It also has to be outside: the pool holds a single connection, so
 * reaching for `sql` while `tx` owns it would wait on itself forever.)
 *
 * The meal and its items then go in one transaction, because a meal with half
 * its items saved is worse than no meal at all — the total is wrong, it looks
 * right, and nothing marks it as partial.
 */
export async function saveMeal(draft: MealDraft): Promise<SavedMeal> {
  if (draft.items.length === 0) throw new Error("a meal needs at least one item");

  const resolved: { item: DraftItem; food: FoodRow }[] = [];
  for (const item of draft.items) {
    resolved.push({ item, food: await resolveFood(item.name, item.composition) });
  }

  const mealId = await sql.begin(async (tx) => {
    const [meal] = await tx<{ id: number }[]>`
      insert into meals (eaten_on, logged_via, raw_input, note)
      values (${draft.eatenOn}, ${draft.loggedVia},
              ${draft.rawInput ?? null}, ${draft.note ?? null})
      returning id`;

    for (const { item, food } of resolved) {
      await tx`
        insert into meal_items (meal_id, food_id, grams, count, edited)
        values (${meal.id}, ${food.id}, ${item.grams},
                ${item.count ?? null}, ${item.edited ?? false})`;
    }
    return meal.id;
  });

  const [saved] = await mealsWithTotals(sql`m.id = ${mealId}`);
  return saved;
}

/** Totals for whichever meals the fragment selects. */
async function mealsWithTotals(where: ReturnType<typeof sql>) {
  return sql<SavedMeal[]>`
    select
      m.id::int as id,
      to_char(m.eaten_on, 'YYYY-MM-DD') as "eatenOn",
      count(mi.id)::int as "itemCount",
      round(sum(f.kcal_per_100g      * mi.grams / 100.0))::int   as kcal,
      round(sum(f.protein_g_per_100g * mi.grams / 100.0))::int   as "proteinG",
      round(sum(f.carbs_g_per_100g   * mi.grams / 100.0))::int   as "carbsG",
      round(sum(f.fat_g_per_100g     * mi.grams / 100.0))::int   as "fatG",
      coalesce(
        sum(f.kcal_per_100g * mi.grams / 100.0)
          filter (where f.source = 'model')
        / nullif(sum(f.kcal_per_100g * mi.grams / 100.0), 0),
      0)::float as "estimatedShare"
    from meals m
    join meal_items mi on mi.meal_id = m.id
    join foods f       on f.id = mi.food_id
    where ${where}
    group by m.id
    order by m.eaten_on desc, m.id desc`;
}

export interface DayIntake extends MealTotals {
  date: string;
  meals: number;
}

/**
 * Daily intake over a window.
 *
 * Days with no meals are absent from the result, and that is deliberate — this
 * function reports what was *logged*, and it has no way to tell a fasting day
 * from a day the athlete forgot. Callers that need a calendar fill the gaps
 * themselves and label them as unlogged, never as zero.
 */
export async function dailyIntake(from: string, to: string): Promise<DayIntake[]> {
  return sql<DayIntake[]>`
    select
      to_char(m.eaten_on, 'YYYY-MM-DD') as date,
      count(distinct m.id)::int as meals,
      round(sum(f.kcal_per_100g      * mi.grams / 100.0))::int as kcal,
      round(sum(f.protein_g_per_100g * mi.grams / 100.0))::int as "proteinG",
      round(sum(f.carbs_g_per_100g   * mi.grams / 100.0))::int as "carbsG",
      round(sum(f.fat_g_per_100g     * mi.grams / 100.0))::int as "fatG",
      coalesce(
        sum(f.kcal_per_100g * mi.grams / 100.0)
          filter (where f.source = 'model')
        / nullif(sum(f.kcal_per_100g * mi.grams / 100.0), 0),
      0)::float as "estimatedShare"
    from meals m
    join meal_items mi on mi.meal_id = m.id
    join foods f       on f.id = mi.food_id
    where m.eaten_on between ${from} and ${to}
    group by m.eaten_on
    order by m.eaten_on`;
}

export async function recentMeals(limit = 8): Promise<SavedMeal[]> {
  return sql<SavedMeal[]>`
    select
      m.id::int as id,
      to_char(m.eaten_on, 'YYYY-MM-DD') as "eatenOn",
      count(mi.id)::int as "itemCount",
      round(sum(f.kcal_per_100g      * mi.grams / 100.0))::int as kcal,
      round(sum(f.protein_g_per_100g * mi.grams / 100.0))::int as "proteinG",
      round(sum(f.carbs_g_per_100g   * mi.grams / 100.0))::int as "carbsG",
      round(sum(f.fat_g_per_100g     * mi.grams / 100.0))::int as "fatG",
      coalesce(
        sum(f.kcal_per_100g * mi.grams / 100.0)
          filter (where f.source = 'model')
        / nullif(sum(f.kcal_per_100g * mi.grams / 100.0), 0),
      0)::float as "estimatedShare"
    from meals m
    join meal_items mi on mi.meal_id = m.id
    join foods f       on f.id = mi.food_id
    group by m.id
    order by m.eaten_on desc, m.id desc
    limit ${limit}`;
}

export async function deleteMeal(id: number): Promise<void> {
  await sql`delete from meals where id = ${id}`;
}
