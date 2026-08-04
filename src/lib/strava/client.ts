import { getAccessToken } from "./oauth";
import { summaryActivitySchema, type SummaryActivity } from "./types";

const API_BASE = "https://www.strava.com/api/v3";

export interface RateLimitStatus {
  /** Requests used / allowed in the current 15-minute window. */
  shortTermUsage: number;
  shortTermLimit: number;
  dailyUsage: number;
  dailyLimit: number;
}

function parseRateLimit(headers: Headers): RateLimitStatus | null {
  // Strava sends these as "short,daily" pairs, e.g. limit "200,2000" usage "13,412".
  const limit = headers.get("x-ratelimit-limit");
  const usage = headers.get("x-ratelimit-usage");
  if (!limit || !usage) return null;

  const [shortTermLimit, dailyLimit] = limit.split(",").map(Number);
  const [shortTermUsage, dailyUsage] = usage.split(",").map(Number);
  if ([shortTermLimit, dailyLimit, shortTermUsage, dailyUsage].some(Number.isNaN)) {
    return null;
  }
  return { shortTermLimit, dailyLimit, shortTermUsage, dailyUsage };
}

/** Milliseconds until the top of the next 15-minute window, when short-term quota resets. */
function msUntilWindowReset(now = new Date()): number {
  const next = new Date(now);
  next.setMinutes(Math.floor(now.getMinutes() / 15) * 15 + 15, 0, 0);
  return next.getTime() - now.getTime();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StravaRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "StravaRateLimitError";
  }
}

export interface StravaClientOptions {
  athleteId?: number;
  /** Wait out a 429 and retry rather than throwing. Backfill wants this; a webhook doesn't. */
  waitOnRateLimit?: boolean;
  onRateLimit?: (status: RateLimitStatus) => void;
}

export class StravaClient {
  private lastRateLimit: RateLimitStatus | null = null;

  constructor(private readonly options: StravaClientOptions = {}) {}

  get rateLimit(): RateLimitStatus | null {
    return this.lastRateLimit;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | number> = {},
    attempt = 0,
  ): Promise<T> {
    const { accessToken } = await getAccessToken(this.options.athleteId);
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    const status = parseRateLimit(res.headers);
    if (status) {
      this.lastRateLimit = status;
      this.options.onRateLimit?.(status);
    }

    if (res.status === 429) {
      const retryAfterMs = msUntilWindowReset();
      if (this.options.waitOnRateLimit && attempt < 3) {
        await sleep(retryAfterMs + 1_000);
        return this.request<T>(path, params, attempt + 1);
      }
      throw new StravaRateLimitError(
        `Strava rate limit hit on ${path}; resets in ${Math.ceil(retryAfterMs / 1000)}s`,
        retryAfterMs,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Strava ${res.status} on ${path}: ${body.slice(0, 500)}`);
    }

    return (await res.json()) as T;
  }

  /**
   * One page of the athlete's activities, newest first.
   * `after`/`before` are unix seconds and filter on activity start time.
   */
  async listActivities(opts: {
    page?: number;
    perPage?: number;
    after?: number;
    before?: number;
  }): Promise<SummaryActivity[]> {
    const params: Record<string, string | number> = {
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 100,
    };
    if (opts.after !== undefined) params.after = opts.after;
    if (opts.before !== undefined) params.before = opts.before;

    const raw = await this.request<unknown[]>("/athlete/activities", params);
    return raw.map((a) => summaryActivitySchema.parse(a));
  }

  async getActivity(id: number): Promise<SummaryActivity> {
    const raw = await this.request<unknown>(`/activities/${id}`, {
      include_all_efforts: "false",
    });
    return summaryActivitySchema.parse(raw);
  }

  /**
   * Every activity from `after` onwards, walking pages until Strava returns a
   * short page. Yields per page so callers can persist incrementally — a
   * multi-year backfill shouldn't hold everything in memory or lose it all on failure.
   */
  async *iterateActivities(opts: {
    after?: number;
    perPage?: number;
  } = {}): AsyncGenerator<SummaryActivity[]> {
    const perPage = opts.perPage ?? 100;
    for (let page = 1; ; page++) {
      const batch = await this.listActivities({
        page,
        perPage,
        after: opts.after,
      });
      if (batch.length > 0) yield batch;
      if (batch.length < perPage) return;
    }
  }
}
