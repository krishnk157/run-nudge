import { NextResponse, type NextRequest } from "next/server";

/**
 * Everything here is one person's health data, and one route is a language
 * model with read access to the whole database.
 *
 * Until Day 8 that did not matter: the app only ever ran on localhost. The
 * first production deploy made it a public URL, and the dashboard, the chat
 * endpoint and the three write routes had no authentication of any kind
 * between them and the internet. Anyone with the address could read the
 * athlete's training history and weight, ask questions that run SQL against
 * it, and spend the API credits doing so.
 *
 * A single-user system deserves a single-user answer: one shared secret, one
 * cookie, no accounts table. What it does not deserve is nothing.
 *
 * Three paths stay open, each because something other than a cookie
 * authenticates it:
 *
 *   /api/strava/webhook   Strava calls this from its own infrastructure and
 *                         cannot present a cookie. The GET handshake checks
 *                         the verify token; the POST body carries an activity
 *                         id that is fetched from Strava before anything is
 *                         written, so a forged event produces a failed lookup
 *                         rather than a false notification.
 *   /api/strava/callback  The OAuth redirect, reached from Strava's domain
 *                         with a code only Strava could have issued.
 *   /api/cron/*           Already gated by CRON_SECRET, checked in the route
 *                         with a timing-safe comparison, and failing closed
 *                         when the variable is unset.
 */
const OPEN_PATHS = [
  "/api/strava/webhook",
  "/api/strava/callback",
  "/api/cron/",
  "/api/auth",
];

export const COOKIE = "rn_session";

/**
 * Constant-time comparison. `===` on a secret leaks its length and prefix
 * through timing, and middleware runs on the edge runtime where
 * `node:crypto.timingSafeEqual` is not available.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const secret = process.env.ADMIN_TOKEN;
  // Fails closed, deliberately. An unset secret locking the owner out is a
  // visible problem; an unset secret opening the database is not.
  if (!secret) {
    return NextResponse.json(
      { error: "ADMIN_TOKEN is not set — refusing to serve" },
      { status: 503 },
    );
  }

  const presented = req.cookies.get(COOKIE)?.value ?? "";
  if (safeEqual(presented, secret)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Training monitor</title>
     <style>
       body{background:#070e13;color:#9db4bf;font:15px/1.6 -apple-system,system-ui,sans-serif;
            display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
       div{max-width:34ch;text-align:center}
       code{font:12px ui-monospace,Menlo,monospace;color:#46b9c7;word-break:break-all}
     </style>
     <div>
       <p>This dashboard is private.</p>
       <p><code>/api/auth?token=&lt;ADMIN_TOKEN&gt;</code></p>
       <p style="color:#5e7482;font-size:13px">Opening that once sets a cookie on this device.</p>
     </div>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export const config = {
  // Static assets are excluded: they carry nothing private, and putting the
  // check in front of every chunk request costs latency for no benefit.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
