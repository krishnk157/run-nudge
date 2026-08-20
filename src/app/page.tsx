import "./dashboard.css";

import { ChatPanel } from "@/components/ChatPanel";
import { Coverage } from "@/components/Coverage";
import { AskLink, EfficiencyChart, LoadBars } from "@/components/DashboardClient";
import { getDashboardData } from "@/lib/dashboard/data";

export const dynamic = "force-dynamic";

function Row({
  label,
  value,
  note,
  noteClass,
  stale,
  isVoid,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
  noteClass?: string;
  stale?: string;
  isVoid?: boolean;
}) {
  return (
    <div className={`ro ${isVoid ? "is-void" : ""}`}>
      <div className="lbl">{label}</div>
      <div className="ro-val num">{value}</div>
      {note && <div className={`ro-note ${noteClass ?? ""}`}>{note}</div>}
      {stale && <div className="stale">▲ {stale}</div>}
    </div>
  );
}

export default async function Home() {
  let data;
  try {
    data = await getDashboardData();
  } catch (e) {
    return (
      <main className="wrap">
        <h1 style={{ fontSize: 20, marginTop: 40 }}>RunNudge</h1>
        <p className="note" style={{ color: "var(--crit)" }}>
          {e instanceof Error ? e.message : String(e)}
        </p>
      </main>
    );
  }

  const { state, freshness, findings, weekly, efficiency, feed, totals } = data;
  const idle = state.daysSinceLast != null && state.daysSinceLast >= 3;
  const stale = freshness.daysSinceSync != null && freshness.daysSinceSync >= 2;
  const latestEff = efficiency.at(-1);

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand">
            <span className={`pulse ${idle ? "" : "live"}`} />
            RunNudge
            <span className="brand-sub">TRAINING MONITOR</span>
          </div>
          <div style={{ flex: 1 }} />
          <ChatPanel />
        </div>
      </header>

      <main className="wrap">
        <section className="sec">
          <div className="sec-head">
            <span className="lbl">State of training</span>
            <span className="lbl meta">
              {stale
                ? `⚠ data last synced ${freshness.lastSyncedAt} (${freshness.daysSinceSync}d ago)`
                : `synced ${freshness.lastSyncedAt}`}
            </span>
          </div>

          <div className="readouts">
            <Row
              label="Load this week"
              value={state.weekLoad}
              note={
                state.weekSessions === 0
                  ? state.daysSinceLast != null
                    ? `${state.daysSinceLast} days since last session`
                    : "no sessions recorded"
                  : `${state.weekSessions} session${state.weekSessions === 1 ? "" : "s"}`
              }
              isVoid={state.weekLoad === 0}
            />
            <Row
              label="Last session"
              value={state.daysSinceLast === 0 ? "today" : `${state.daysSinceLast ?? "—"}d`}
              note={state.lastActivityDate ?? "—"}
              isVoid={idle}
            />
            <Row
              label="Load ratio"
              value={state.acwr ?? "—"}
              note={
                state.acwrStale
                  ? "not enough recent training to compute"
                  : "within band"
              }
              noteClass={state.acwrStale ? "" : "delta-up"}
              stale={
                state.acwrStale && state.acwrAsOf
                  ? `last computed ${state.acwrAsOf}`
                  : undefined
              }
              isVoid={state.acwr == null}
            />
            <Row
              label="VO₂max"
              value={state.vo2max ?? "—"}
              note={
                state.vo2maxChange != null
                  ? `${state.vo2maxChange > 0 ? "▲" : "▼"} ${Math.abs(state.vo2maxChange)} since ${state.vo2maxSince}`
                  : "no readings"
              }
              noteClass={
                state.vo2maxChange != null && state.vo2maxChange < 0
                  ? "delta-down"
                  : "delta-up"
              }
              isVoid={state.vo2max == null}
            />
          </div>
        </section>

        <Coverage findings={findings} />

        <section className="sec">
          <div className="sec-head">
            <span className="lbl">What I&rsquo;ve told you</span>
            <span className="lbl meta">
              {feed.filter((f) => f.decision === "notify").length} sent ·{" "}
              {feed.filter((f) => f.decision === "skip").length} withheld
            </span>
          </div>

          <div className="feed">
            {feed.length === 0 && (
              <div className="entry">
                <div className="entry-when">—</div>
                <div className="entry-body">
                  <p className="entry-msg" style={{ color: "var(--ink-3)" }}>
                    Nothing yet. Notifications appear here once an activity has
                    been judged — including the ones deliberately withheld.
                  </p>
                </div>
              </div>
            )}

            {feed.map((e) => {
              const quiet = e.decision !== "notify";
              const [date, time] = e.createdAt.split(" ");
              return (
                <article className={`entry ${quiet ? "quiet" : ""}`} key={e.id}>
                  <div className="entry-when">
                    <b>{date}</b>
                    {time}
                    {e.activityDate && <br />}
                    {e.activityDate && `run ${e.activityDate}`}
                  </div>
                  <div className="entry-body">
                    <div className="entry-kind">
                      {e.decision === "notify"
                        ? `${e.trigger === "cron" ? "Weekly digest" : "Sent"}${e.severity ? ` · ${e.severity}` : ""}`
                        : e.decision === "skip"
                          ? "Withheld · nothing worth sending"
                          : "Error"}
                    </div>
                    <p className="entry-msg">
                      {e.message ??
                        "No message — the judge decided this wasn't worth sending."}
                    </p>
                    {e.chips.length > 0 && (
                      <div className="chips">
                        {e.chips.map((c, i) => (
                          <span className={`chip ${c.tone}`} key={i}>
                            {c.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* The rationale is the debugging trail the plan asked for —
                        and the thing that caught a real bug on Day 4. */}
                    {e.rationale && <div className="rationale">{e.rationale}</div>}
                    <div className="sent-via">
                      {e.status === "sent"
                        ? `delivered via telegram · trigger: ${e.trigger}`
                        : e.decision === "skip"
                          ? "no notification — logged only"
                          : `${e.status} · trigger: ${e.trigger}`}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="sec">
          <div className="sec-head">
            <span className="lbl">Trends</span>
            <span className="lbl meta">{totals.activities} activities on file</span>
          </div>

          <div className="charts">
            <AskLink question="Why did my training load change over the last few months?">
              <div className="chart-head">
                <span className="lbl">Weekly load · gym + runs</span>
                <span className="chart-val">{state.weekLoad}</span>
              </div>
              <LoadBars weekly={weekly} />
              <div className="chart-note">
                bars, not a line — a zero week is zero, not interpolated
              </div>
            </AskLink>

            <AskLink question="Is my aerobic efficiency improving?">
              <div className="chart-head">
                <span className="lbl">Aerobic efficiency · m/s per bpm</span>
                <span className="chart-val">
                  {latestEff ? (latestEff.index * 1000).toFixed(2) : "—"}
                </span>
              </div>
              {efficiency.length > 0 ? (
                <EfficiencyChart points={efficiency} />
              ) : (
                <div className="empty-chart">
                  <span>no runs with heart rate yet</span>
                </div>
              )}
              <div className="chart-note">
                {efficiency.length} reading{efficiency.length === 1 ? "" : "s"} · gaps
                left open, never joined across weeks
              </div>
            </AskLink>

            <AskLink question="How many gym sessions have I done each week?">
              <div className="chart-head">
                <span className="lbl">Sessions per week</span>
                <span className="chart-val">{state.weekSessions}</span>
              </div>
              <LoadBars
                weekly={weekly.map((w) => ({
                  ...w,
                  load: w.gymSessions + w.runSessions,
                }))}
              />
              <div className="chart-note">gym and runs combined, by week</div>
            </AskLink>

            <div className="chart">
              <div className="chart-head">
                <span className="lbl">Bodyweight</span>
                <span className="chart-val" style={{ color: "var(--dormant)" }}>
                  —
                </span>
              </div>
              <div className="empty-chart">
                <span>no entries yet</span>
                <span style={{ opacity: 0.7 }}>logging arrives on Day 7</span>
              </div>
              <div className="chart-note">
                read within the phase in force — never averaged across a bulk and a cut
              </div>
            </div>
          </div>
        </section>

        <p className="note">
          Every figure here is computed in SQL or by the analysis engine —
          nothing on this page is estimated. {totals.notifications} judgments
          recorded, {totals.sent} delivered. Press{" "}
          <kbd style={{ fontFamily: "var(--font-data)" }}>⌘K</kbd> to ask
          questions of the same data.
        </p>
      </main>
    </>
  );
}
