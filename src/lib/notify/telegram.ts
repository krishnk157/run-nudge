import type { DeliveryResult, Notifier, OutgoingMessage } from "./types";

/**
 * Telegram Bot API delivery.
 *
 * Chosen over email for the per-activity path because the plan's Day 5
 * outcome is a notification arriving *on your phone* — Telegram gives a push
 * with no domain verification, no sending reputation, and no cost.
 */

const API = "https://api.telegram.org";

/** Telegram's MarkdownV2 reserves these; unescaped, they 400 the send. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

const SEVERITY_MARK: Record<string, string> = {
  warning: "▲",
  notable: "▸",
  info: "·",
};

export class TelegramNotifier implements Notifier {
  readonly channel = "telegram";

  constructor(
    private readonly token = process.env.TELEGRAM_BOT_TOKEN,
    private readonly chatId = process.env.TELEGRAM_CHAT_ID,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  async send(message: OutgoingMessage): Promise<DeliveryResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set",
      };
    }

    const mark = message.severity ? SEVERITY_MARK[message.severity] : null;
    const heading = mark ? `${mark} ${message.subject}` : message.subject;
    const text = `*${escapeMarkdown(heading)}*\n\n${escapeMarkdown(message.body)}`;

    try {
      const res = await fetch(`${API}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "MarkdownV2",
          disable_notification: message.severity === "info",
        }),
        cache: "no-store",
      });

      const body = (await res.json()) as {
        ok: boolean;
        description?: string;
        result?: { message_id: number };
      };

      if (!res.ok || !body.ok) {
        return {
          ok: false,
          error: `telegram ${res.status}: ${body.description ?? "unknown error"}`,
        };
      }
      return { ok: true, externalId: String(body.result?.message_id ?? "") };
    } catch (e) {
      // Network failure is a delivery failure, not a pipeline failure — the
      // caller records it against the notification and moves on.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
