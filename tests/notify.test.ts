import { describe, expect, it, vi } from "vitest";

import { fallbackBody, type WeekStats } from "@/lib/llm/digest";
import { TelegramNotifier } from "@/lib/notify/telegram";

/**
 * Delivery-layer invariants. The channel itself can't be unit-tested without
 * hitting Telegram, but the two things that actually break sends are pure:
 * MarkdownV2 escaping, and the configured/unconfigured gate.
 */

function mockFetch(response: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 400,
    json: async () => response,
  });
}

describe("TelegramNotifier", () => {
  it("reports unconfigured rather than throwing when credentials are missing", async () => {
    const n = new TelegramNotifier(undefined, undefined);
    expect(n.isConfigured()).toBe(false);
    const r = await n.send({ subject: "x", body: "y" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not set/);
  });

  it("escapes every MarkdownV2 reserved character", async () => {
    // Unescaped, any of these 400s the send. A load-ratio message contains
    // dots, parens and slashes as a matter of course, so this is the common
    // case and not an edge case.
    const fetchMock = mockFetch({ ok: true, result: { message_id: 7 } });
    vi.stubGlobal("fetch", fetchMock);

    const n = new TelegramNotifier("tok", "123");
    await n.send({
      subject: "Load ratio 1.51 above baseline",
      // Contains a literal hyphen, not an em dash: only the ASCII hyphen is
      // reserved in MarkdownV2, and the first version of this test used "—"
      // and so never exercised the case it claimed to.
      body: "Acute 44.5 (chronic 29.4) - first run in 28 days! See_notes [here].",
      severity: "notable",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Every reserved char that appears must be backslash-escaped.
    for (const ch of [".", "(", ")", "-", "!", "_", "[", "]"]) {
      const idx = body.text.indexOf(ch);
      expect(idx, `"${ch}" should appear`).toBeGreaterThan(-1);
      expect(body.text[idx - 1], `"${ch}" should be escaped`).toBe("\\");
    }
    vi.unstubAllGlobals();
  });

  it("silences info-severity messages and pushes the rest", async () => {
    const fetchMock = mockFetch({ ok: true, result: { message_id: 1 } });
    vi.stubGlobal("fetch", fetchMock);
    const n = new TelegramNotifier("tok", "123");

    await n.send({ subject: "s", body: "b", severity: "info" });
    await n.send({ subject: "s", body: "b", severity: "warning" });

    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(first.disable_notification).toBe(true);
    expect(second.disable_notification).toBe(false);
    vi.unstubAllGlobals();
  });

  it("surfaces a Telegram API error instead of reporting success", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ ok: false, description: "chat not found" }, false),
    );
    const n = new TelegramNotifier("tok", "bad");
    const r = await n.send({ subject: "s", body: "b" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/chat not found/);
    vi.unstubAllGlobals();
  });

  it("treats a network failure as a delivery failure, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const n = new TelegramNotifier("tok", "123");
    const r = await n.send({ subject: "s", body: "b" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
    vi.unstubAllGlobals();
  });
});

describe("digest fallback", () => {
  const base: WeekStats = {
    weekStart: "2026-08-11",
    weekEnd: "2026-08-18",
    lastSyncedAt: "2026-08-18 09:00",
    daysSinceSync: 0,
    sessions: 0,
    hours: 0,
    distanceKm: 0,
    bySport: [],
    runs: [],
    priorWeekSessions: 2,
    priorWeekHours: 1.4,
    bodyweight: [],
  };

  it("states a zero-session week plainly rather than padding it", () => {
    // A quiet week is a valid digest — the deterministic path must not
    // invent significance any more than the model may.
    expect(fallbackBody(base)).toBe(
      "No sessions recorded between 2026-08-11 and 2026-08-18.",
    );
  });

  it("refuses to assert an empty week when the data is stale", () => {
    // The incident this guards: the first live digest reported "no sessions
    // recorded" for a week containing four gym sessions, because activity
    // data was 8 days old and nothing told it so.
    const body = fallbackBody({
      ...base,
      lastSyncedAt: "2026-08-09 22:14",
      daysSinceSync: 8,
    });
    expect(body).toContain("have been synced");
    expect(body).not.toContain("No sessions recorded");
    expect(body).toContain("8 days ago");
  });

  it("summarises a real week with only computed numbers", () => {
    const body = fallbackBody({
      ...base,
      sessions: 3,
      hours: 2.5,
      bySport: [
        { sportType: "WeightTraining", sessions: 2, hours: 1.9 },
        { sportType: "Run", sessions: 1, hours: 0.6 },
      ],
      runs: [{ date: "Sun 16 Aug", km: 5.01, pacePerKm: "07:26", avgHr: 175.8 }],
    });
    expect(body).toContain("3 sessions, 2.5 hours");
    expect(body).toContain("2 × WeightTraining");
    expect(body).toContain("5.01 km at 07:26/km");
    expect(body).toContain("Previous week: 2 sessions");
  });
});
