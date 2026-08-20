import { describe, expect, it } from "vitest";

import { chatTools } from "@/lib/chat/aiTools";
import { CHAT_SYSTEM } from "@/lib/chat/prompt";
import { validateQuery } from "@/lib/chat/queryMetrics";

/**
 * The chat layer's guardrails.
 *
 * `validateQuery` is defence in depth — Postgres's READ ONLY transaction is
 * what actually keeps the data safe — but it's the layer that gives the model
 * a fast, specific error, and it's the only part that's pure enough to pin
 * without a database.
 */

describe("validateQuery", () => {
  it("accepts ordinary read queries", () => {
    for (const q of [
      "SELECT count(*) FROM activities",
      "select sport_type, count(*) from activities group by 1",
      "WITH w AS (SELECT 1 AS n) SELECT n FROM w",
      "  select 1  ;  ", // trailing semicolon is stripped, not rejected
    ]) {
      expect(validateQuery(q), q).toBeNull();
    }
  });

  it("rejects every write verb", () => {
    for (const q of [
      "INSERT INTO activities VALUES (1)",
      "UPDATE activities SET name = 'x'",
      "DELETE FROM activities",
      "DROP TABLE activities",
      "TRUNCATE activities",
      "ALTER TABLE activities ADD COLUMN x int",
      "CREATE TABLE t (id int)",
      "GRANT ALL ON activities TO public",
    ]) {
      expect(validateQuery(q), q).not.toBeNull();
    }
  });

  it("rejects stacked statements — the classic injection lever", () => {
    // A READ ONLY transaction would still happily run a second SELECT that
    // dumps something unintended, so the semicolon is blocked outright.
    expect(
      validateQuery("SELECT 1; SELECT * FROM strava_tokens"),
    ).toMatch(/single statement/);
  });

  it("rejects a write smuggled inside a CTE", () => {
    expect(
      validateQuery(
        "WITH x AS (DELETE FROM activities RETURNING *) SELECT * FROM x",
      ),
    ).not.toBeNull();
  });

  it("rejects filesystem and sleep functions", () => {
    expect(validateQuery("SELECT pg_read_file('/etc/passwd')")).not.toBeNull();
    expect(validateQuery("SELECT pg_sleep(60)")).not.toBeNull();
  });

  it("does not trip on column names containing forbidden words", () => {
    // `created_at` contains "create", `updated_at` contains "update". A naive
    // substring check would reject both and make the tool useless.
    expect(
      validateQuery("select created_at, updated_at from activities"),
    ).toBeNull();
    expect(
      validateQuery("select ingested_at from activities order by created_at"),
    ).toBeNull();
  });

  it("rejects an empty query rather than sending it", () => {
    expect(validateQuery("   ")).toMatch(/empty/);
  });
});

describe("render_chart", () => {
  it("returns a spec without touching the database", async () => {
    // Pure by design: the chart can only plot figures an earlier
    // query_metrics call already fetched and the model already quoted.
    const out = await chatTools.render_chart.execute!(
      {
        title: "Weekly load",
        type: "bar",
        points: [
          { x: "2026-08-10", y: 162 },
          { x: "2026-08-17", y: 69 },
        ],
      },
      // render_chart ignores its execution options entirely — it is pure —
      // so the harness context is irrelevant to what this test asserts.
      {} as Parameters<NonNullable<typeof chatTools.render_chart.execute>>[1],
    );
    expect(out).toMatchObject({ ok: true, title: "Weekly load" });
    expect((out as { points: unknown[] }).points).toHaveLength(2);
  });
});

describe("chat contract", () => {
  it("exposes exactly the two planned tools", () => {
    expect(Object.keys(chatTools).sort()).toEqual([
      "query_metrics",
      "render_chart",
    ]);
  });

  it("gives the model the schema, including the traps", () => {
    // The column list is the easy half; the semantics are what stop a
    // syntactically valid query returning a wrong answer.
    const d = chatTools.query_metrics.description ?? "";
    expect(d).toContain("started_at_local");
    expect(d).toMatch(/wall clock/i);
    expect(d).toMatch(/valid_sleep/);
  });

  it("steers charts away from implying continuity across gaps", () => {
    const d = chatTools.render_chart.description ?? "";
    expect(d).toMatch(/bars show a zero and lines hide it/i);
    expect(d).toMatch(/never chart across a gap/i);
  });

  it("tells the model it may not invent numbers", () => {
    expect(CHAT_SYSTEM).toMatch(/must come from a query_metrics result/i);
    expect(CHAT_SYSTEM).toMatch(/do not estimate/i);
  });

  it("carries the absence-vs-nonexistence rule", () => {
    // The same honesty constraint as the judge and the digest — an empty
    // result set is not evidence that nothing happened.
    expect(CHAT_SYSTEM).toMatch(/absence of rows as an absence of training/i);
  });

  it("warns the model that activity data can be stale", () => {
    // Day 5's incident, carried into the chat layer: a question about the
    // last day or two must check ingested_at before asserting nothing
    // happened. Verified live — the model volunteered the caveat unprompted.
    expect(CHAT_SYSTEM).toMatch(/ingested_at/);
  });
});
