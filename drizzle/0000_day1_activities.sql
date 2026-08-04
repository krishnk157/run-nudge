CREATE TABLE "activities" (
	"id" bigint PRIMARY KEY NOT NULL,
	"athlete_id" bigint NOT NULL,
	"source" text DEFAULT 'strava' NOT NULL,
	"name" text NOT NULL,
	"sport_type" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"started_at_local" timestamp NOT NULL,
	"timezone" text,
	"utc_offset_seconds" integer,
	"distance_m" double precision NOT NULL,
	"moving_time_s" integer NOT NULL,
	"elapsed_time_s" integer NOT NULL,
	"total_elevation_gain_m" double precision,
	"average_speed_mps" double precision,
	"max_speed_mps" double precision,
	"has_heartrate" boolean DEFAULT false NOT NULL,
	"average_heartrate" double precision,
	"max_heartrate" double precision,
	"average_cadence" double precision,
	"suffer_score" integer,
	"kilojoules" double precision,
	"is_trainer" boolean DEFAULT false NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"is_race" boolean DEFAULT false NOT NULL,
	"gear_id" text,
	"raw" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strava_tokens" (
	"athlete_id" bigint PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"athlete_firstname" text,
	"athlete_lastname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activities_athlete_started_idx" ON "activities" USING btree ("athlete_id","started_at");--> statement-breakpoint
CREATE INDEX "activities_sport_type_idx" ON "activities" USING btree ("sport_type");