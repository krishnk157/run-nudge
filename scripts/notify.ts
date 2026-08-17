/**
 * Notification delivery utilities — the local equivalent of the cron routes.
 *
 *   npm run notify -- chat-id      # read your chat ID from getUpdates
 *   npm run notify -- test         # send a hello message
 *   npm run notify -- pending      # deliver drafted notifications
 *   npm run notify -- digest       # build this week's digest and send it
 *   npm run notify -- digest --dry # build it, print it, send nothing
 */
import "dotenv/config";

import { sql } from "@/db/client";
import { fallbackBody, weekStats, writeDigest } from "@/lib/llm/digest";
import { deliverPending } from "@/lib/notify/deliver";
import { TelegramNotifier } from "@/lib/notify/telegram";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");

/**
 * Telegram won't tell you your own chat ID; it appears once you message the
 * bot. getUpdates then reports it. This is the one manual step in setup.
 */
async function chatId() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set in .env");
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: {
      message?: { chat?: { id: number; first_name?: string; username?: string } };
    }[];
  };

  if (!body.ok) {
    console.error(`Telegram error: ${body.description}`);
    console.error("A 401 here means the bot token is wrong.");
    process.exit(1);
  }

  const chats = new Map<number, string>();
  for (const u of body.result ?? []) {
    const c = u.message?.chat;
    if (c) chats.set(c.id, c.username ?? c.first_name ?? "");
  }

  if (chats.size === 0) {
    console.log(
      "No messages yet. Open your bot in Telegram, send it any message, then re-run.\n" +
        "(getUpdates only reports chats that have messaged the bot.)",
    );
    return;
  }
  for (const [id, who] of chats) {
    console.log(`TELEGRAM_CHAT_ID="${id}"   ${who ? `— ${who}` : ""}`);
  }
}

async function test() {
  const n = new TelegramNotifier();
  if (!n.isConfigured()) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.");
    process.exit(1);
  }
  const r = await n.send({
    subject: "RunNudge is connected",
    // Deliberately exercises MarkdownV2 escaping: dots, dashes, parens.
    body: "Delivery test — if you can read this, notifications work. Load ratio 1.51 (acute 44.5 / chronic 29.4).",
    severity: "notable",
  });
  console.log(r.ok ? `Sent (message_id ${r.externalId})` : `Failed: ${r.error}`);
}

async function pending() {
  const s = await deliverPending();
  console.log(
    `attempted ${s.attempted} · sent ${s.sent} · failed ${s.failed}` +
      (s.errors.length ? `\n${s.errors.join("\n")}` : ""),
  );
}

async function digest() {
  if (dry) {
    // No model call: shows exactly what the deterministic fallback would say.
    const s = await weekStats();
    console.log(JSON.stringify(s, null, 1));
    console.log("\n--- fallback body ---\n" + fallbackBody(s));
    return;
  }

  const { digest: d, stats } = await writeDigest();
  console.log(`subject: ${d.subject}`);
  console.log(`body:    ${d.body}`);
  console.log(
    `\n(${stats.sessions} sessions this week · ${d.inputTokens} in / ${d.outputTokens} out` +
      `${d.degraded ? ` · DEGRADED: ${d.degraded}` : ""})`,
  );

  const n = new TelegramNotifier();
  if (!n.isConfigured()) {
    console.log("\nTelegram not configured — not sent.");
    return;
  }
  const r = await n.send({ subject: d.subject, body: d.body, severity: "info" });
  console.log(r.ok ? "\nSent." : `\nSend failed: ${r.error}`);
}

async function main() {
  const cmd = argv[0];
  if (cmd === "chat-id") return chatId();
  if (cmd === "test") return test();
  if (cmd === "pending") return pending();
  if (cmd === "digest") return digest();
  console.log("usage: npm run notify -- chat-id | test | pending | digest [--dry]");
  process.exit(1);
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("Failed:", e);
    await sql.end();
    process.exit(1);
  });
