CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"activity_id" bigint,
	"decision" text NOT NULL,
	"severity" text,
	"subject" text,
	"message" text,
	"rationale" text,
	"findings" jsonb NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"status" text DEFAULT 'drafted' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"object_type" text NOT NULL,
	"object_id" bigint NOT NULL,
	"aspect_type" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"raw" jsonb NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");