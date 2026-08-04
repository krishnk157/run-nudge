import { z } from "zod";

/**
 * Env is validated lazily rather than at module load so that importing a module
 * (e.g. the schema, in drizzle-kit) never requires the full app config to be present.
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().min(1),
  STRAVA_CLIENT_ID: z.string().min(1),
  STRAVA_CLIENT_SECRET: z.string().min(1),
  /** Public origin of this deployment, e.g. https://run-nudge.vercel.app or http://localhost:3000 */
  APP_URL: z.string().url(),
  /** Shared secret guarding the single-user OAuth entrypoint. */
  ADMIN_TOKEN: z.string().min(16),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export function stravaRedirectUri(): string {
  return `${env().APP_URL}/api/strava/callback`;
}
