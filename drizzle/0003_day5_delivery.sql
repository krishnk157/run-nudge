ALTER TABLE "notifications" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "sent_at" timestamp with time zone;