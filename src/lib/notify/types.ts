/**
 * Delivery is deliberately behind an interface.
 *
 * The plan (§3) picks email first with Telegram as an upgrade; we went
 * Telegram first because a phone push *is* the Day 5 outcome. Either way the
 * channel is a detail — the pipeline decides *whether* to speak, and this
 * layer only carries the words. Adding email later is one more implementation
 * of this interface plus a config value, not a change to the pipeline.
 */
export interface OutgoingMessage {
  subject: string;
  body: string;
  /** Advisory only — a channel may ignore it. */
  severity?: "info" | "notable" | "warning" | null;
}

export interface DeliveryResult {
  ok: boolean;
  /** Channel-side id when the send succeeded, for the audit trail. */
  externalId?: string;
  error?: string;
}

export interface Notifier {
  readonly channel: string;
  /** True when the channel has the credentials it needs to send. */
  isConfigured(): boolean;
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}
