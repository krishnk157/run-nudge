CREATE TABLE "body_log" (
	"date" date PRIMARY KEY NOT NULL,
	"weight_kg" double precision NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foods" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kcal_per_100g" double precision NOT NULL,
	"protein_g_per_100g" double precision NOT NULL,
	"carbs_g_per_100g" double precision NOT NULL,
	"fat_g_per_100g" double precision NOT NULL,
	"source" text DEFAULT 'model' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "foods_source" CHECK (source in ('model', 'user'))
);
--> statement-breakpoint
CREATE TABLE "goal_phases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"started_on" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_phases_phase" CHECK (phase in ('bulk', 'cut', 'maintain'))
);
--> statement-breakpoint
CREATE TABLE "meal_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"meal_id" bigint NOT NULL,
	"food_id" bigint NOT NULL,
	"grams" double precision NOT NULL,
	"count" text,
	"edited" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"eaten_on" date NOT NULL,
	"logged_via" text DEFAULT 'text' NOT NULL,
	"raw_input" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meals_logged_via" CHECK (logged_via in ('photo', 'text'))
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"height_cm" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_singleton" CHECK (id = 1)
);
--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_meal_id_meals_id_fk" FOREIGN KEY ("meal_id") REFERENCES "public"."meals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_items" ADD CONSTRAINT "meal_items_food_id_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."foods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "foods_key_idx" ON "foods" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_phases_started_idx" ON "goal_phases" USING btree ("started_on");--> statement-breakpoint
CREATE INDEX "meal_items_meal_idx" ON "meal_items" USING btree ("meal_id");--> statement-breakpoint
CREATE INDEX "meals_eaten_on_idx" ON "meals" USING btree ("eaten_on");