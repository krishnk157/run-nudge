/**
 * Manage the Strava webhook subscription. Strava allows one per application.
 *
 *   npm run webhook -- view
 *   npm run webhook -- create https://<public-url>/api/strava/webhook
 *   npm run webhook -- delete
 *
 * Creating requires the callback URL to be publicly reachable: Strava GETs it
 * with a hub.challenge during this call, so the app must be running and the
 * URL tunneled/deployed *before* subscribing.
 */
import "dotenv/config";

const API = "https://www.strava.com/api/v3/push_subscriptions";

function creds() {
  const client_id = process.env.STRAVA_CLIENT_ID;
  const client_secret = process.env.STRAVA_CLIENT_SECRET;
  const verify_token = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
  if (!client_id || !client_secret || !verify_token) {
    throw new Error(
      "STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET and STRAVA_WEBHOOK_VERIFY_TOKEN must be set",
    );
  }
  return { client_id, client_secret, verify_token };
}

async function view() {
  const { client_id, client_secret } = creds();
  const res = await fetch(
    `${API}?client_id=${client_id}&client_secret=${client_secret}`,
  );
  const subs = (await res.json()) as {
    id: number;
    callback_url: string;
    created_at: string;
  }[];
  if (!Array.isArray(subs) || subs.length === 0) {
    console.log("No subscription registered.");
    return null;
  }
  for (const s of subs) {
    console.log(`subscription ${s.id} → ${s.callback_url} (${s.created_at})`);
  }
  return subs[0];
}

async function create(callbackUrl: string) {
  const { client_id, client_secret, verify_token } = creds();
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      callback_url: callbackUrl,
      verify_token,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`Create failed (${res.status}):`, JSON.stringify(body));
    console.error(
      "Strava must be able to GET the callback URL right now — is the app running and publicly reachable?",
    );
    process.exit(1);
  }
  console.log("Subscribed:", JSON.stringify(body));
}

async function remove() {
  const { client_id, client_secret } = creds();
  const existing = await view();
  if (!existing) return;
  const res = await fetch(
    `${API}/${existing.id}?client_id=${client_id}&client_secret=${client_secret}`,
    { method: "DELETE" },
  );
  console.log(res.status === 204 ? "Deleted." : `Delete failed: ${res.status}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "view") return void (await view());
  if (cmd === "create" && arg) return create(arg);
  if (cmd === "delete") return remove();
  console.log("usage: npm run webhook -- view | create <url> | delete");
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
