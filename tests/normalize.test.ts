import { describe, expect, it } from "vitest";

import { isRun, normalizeActivity, parseProvenance } from "@/lib/strava/normalize";
import { summaryActivitySchema } from "@/lib/strava/types";

/**
 * Ingestion invariants. These cover the two bugs that cost the most time so
 * far — the stripped raw payload and the misread local timestamp — plus the
 * provenance parsing that replaced Day 2's planned fuzzy dedup.
 */

const raw = {
  id: 999000111222,
  athlete: { id: 42 },
  name: "Morning Run",
  sport_type: "Run",
  type: "Run",
  start_date: "2026-03-10T01:32:11Z",
  // Strava's local timestamp carries a Z it does not mean. These digits are
  // wall clock in Asia/Kolkata, not UTC.
  start_date_local: "2026-03-10T07:02:11Z",
  timezone: "(GMT+05:30) Asia/Kolkata",
  utc_offset: 19800,
  distance: 10234.5,
  moving_time: 3120,
  elapsed_time: 3250,
  average_heartrate: 152.4,
  has_heartrate: true,
  workout_type: 1,
  external_id: "garmin_ping_604003275089",
  device_name: "Garmin Forerunner 265",
  // Fields with no column of their own — they must survive into `raw`.
  map: { id: "a1", summary_polyline: "abc" },
  achievement_count: 3,
  visibility: "everyone",
};

describe("summaryActivitySchema", () => {
  it("keeps unknown keys — the archive must not be narrowed by the validator", () => {
    // The Day 1 bug: z.object() strips unknown keys, and since the parsed
    // value is what lands in activities.raw, the column held only the fields
    // that already had columns. It is z.looseObject() for this reason.
    const parsed = summaryActivitySchema.parse(raw) as Record<string, unknown>;
    expect(parsed.map).toEqual(raw.map);
    expect(parsed.achievement_count).toBe(3);
    expect(parsed.visibility).toBe("everyone");
  });

  it("accepts an activity missing every optional field", () => {
    expect(() =>
      summaryActivitySchema.parse({
        id: 1,
        athlete: { id: 2 },
        name: "x",
        start_date: "2026-01-01T00:00:00Z",
        start_date_local: "2026-01-01T00:00:00Z",
        distance: 0,
        moving_time: 1,
        elapsed_time: 1,
      }),
    ).not.toThrow();
  });
});

describe("normalizeActivity", () => {
  const row = normalizeActivity(summaryActivitySchema.parse(raw));

  it("preserves local wall-clock time rather than shifting it", () => {
    expect(row.startedAtLocal.toISOString()).toBe("2026-03-10T07:02:11.000Z");
    expect(row.startedAt.toISOString()).toBe("2026-03-10T01:32:11.000Z");
  });

  it("keeps the IANA timezone and drops Strava's display prefix", () => {
    expect(row.timezone).toBe("Asia/Kolkata");
  });

  it("maps workout_type 1 to a race", () => {
    expect(row.isRace).toBe(true);
  });

  it("carries the full payload into raw, not just the mapped columns", () => {
    const stored = row.raw as Record<string, unknown>;
    expect(stored.map).toBeDefined();
    expect(Object.keys(stored).length).toBeGreaterThan(15);
  });

  it("falls back to the deprecated type when sport_type is absent", () => {
    const legacy = summaryActivitySchema.parse({ ...raw, sport_type: null });
    expect(normalizeActivity(legacy).sportType).toBe("Run");
  });
});

describe("parseProvenance", () => {
  it("extracts the Garmin activity id from a watch auto-push", () => {
    // This is what made Day 2's planned timestamp+distance dedup unnecessary:
    // an exact key, not a heuristic match.
    expect(parseProvenance("garmin_ping_604003275089")).toEqual({
      uploadSource: "garmin",
      garminActivityId: 604003275089,
    });
    expect(parseProvenance("garmin_push_1")).toEqual({
      uploadSource: "garmin",
      garminActivityId: 1,
    });
  });

  it("recognises a file upload without claiming to know the device", () => {
    // A Samsung Galaxy Watch4 recording also arrives this way and does have
    // heart rate — so upload path must never be read as "phone recorded it".
    const r = parseProvenance("5b8ce5a4-88c8-4f4b-879c-f10a98215740-activity.fit");
    expect(r.uploadSource).toBe("file_upload");
    expect(r.garminActivityId).toBeNull();
  });

  it("handles the stripped_ prefix Strava sometimes adds", () => {
    expect(parseProvenance("stripped_abc-activity.fit").uploadSource).toBe(
      "file_upload",
    );
  });

  it("falls back to other for a missing or unrecognised id", () => {
    expect(parseProvenance(null).uploadSource).toBe("other");
    expect(parseProvenance("something-else").uploadSource).toBe("other");
  });
});

describe("isRun", () => {
  it("covers the running sport types and excludes the rest", () => {
    expect(isRun("Run")).toBe(true);
    expect(isRun("TrailRun")).toBe(true);
    expect(isRun("WeightTraining")).toBe(false);
    expect(isRun("Badminton")).toBe(false);
  });
});
