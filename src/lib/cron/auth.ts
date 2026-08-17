import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * Cron routes are public URLs, so they need a shared secret. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` automatically when the variable is set.
 *
 * Fails closed: an unset secret rejects everything rather than leaving the
 * endpoint open. A cron that never fires is a visible problem; an open
 * endpoint that anyone can use to burn API credits is not.
 */
export function authorizeCron(req: NextRequest): { ok: boolean; reason?: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, reason: "CRON_SECRET is not set" };

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return { ok: false, reason: "unauthorized" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "unauthorized" };
}
