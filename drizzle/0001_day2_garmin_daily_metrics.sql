CREATE TABLE "daily_metrics" (
	"date" date PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'garmin' NOT NULL,
	"sleep_seconds" integer,
	"deep_sleep_seconds" integer,
	"light_sleep_seconds" integer,
	"rem_sleep_seconds" integer,
	"awake_seconds" integer,
	"sleep_score" integer,
	"resting_hr" integer,
	"hrv_last_night_avg_ms" integer,
	"hrv_last_night_high_ms" integer,
	"hrv_status" text,
	"hrv_baseline_low_upper" integer,
	"hrv_baseline_balanced_low" integer,
	"hrv_baseline_balanced_upper" integer,
	"vo2max_running" double precision,
	"training_status" text,
	"training_readiness_score" integer,
	"training_readiness_level" text,
	"recovery_time_seconds" integer,
	"acute_training_load" double precision,
	"chronic_training_load" double precision,
	"garmin_acwr" double precision,
	"garmin_acwr_status" text,
	"body_battery_charged" integer,
	"body_battery_drained" integer,
	"average_stress" integer,
	"steps" integer,
	"valid_sleep" boolean,
	"stress_sample_count" integer,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "upload_source" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "garmin_activity_id" bigint;