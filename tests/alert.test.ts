import { describe, expect, it } from "vitest";

import { causeOf } from "@/lib/notify/alert";

/**
 * Alert grouping.
 *
 * The alert is only worth having if it stays worth reading. Five activities
 * failing on one dead key is one problem; five messages about it is a muted
 * chat, and a muted chat is the same as no alert at all.
 */

describe("causeOf", () => {
  it("groups the same fault across different activities", () => {
    // The real incident: two workouts, minutes apart, one expired key.
    const a = `401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null} while fetching 19880077712`;
    const b = `401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null} while fetching 19880240401`;
    expect(causeOf(a)).toBe(causeOf(b));
  });

  it("keeps a different fault distinct, so it is not swallowed by the window", () => {
    // A key problem and a schema problem are two incidents. Throttling the
    // second because the first is open would hide a new failure behind an
    // old one.
    const auth = `401 {"error":{"type":"authentication_error","message":"API key is invalid."}}`;
    const schema = `400 {"error":{"type":"invalid_request_error","message":"output_config.format.schema: Invalid schema"}}`;
    expect(causeOf(auth)).not.toBe(causeOf(schema));
  });

  it("ignores timestamps, which vary within one incident", () => {
    const a = `failed at 2026-08-24T16:12:04.000Z: upstream timeout`;
    const b = `failed at 2026-08-24T16:23:44.000Z: upstream timeout`;
    expect(causeOf(a)).toBe(causeOf(b));
  });

  it("is bounded, so a huge payload cannot become the key", () => {
    expect(causeOf("x".repeat(5000)).length).toBeLessThanOrEqual(120);
  });
});
