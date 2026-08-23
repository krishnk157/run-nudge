import "./dashboard.css";

import { ChatPanel } from "@/components/ChatPanel";
import { Coverage } from "@/components/Coverage";
import { BodyForm } from "@/components/BodyForm";
import { InstallButton } from "@/components/InstallButton";
import {
  AskLink,
  EfficiencyChart,
  LoadBars,
  PaceChart,
  SparseSeries,
  SportMix,
  TrainingCalendar,
  WeightChart,
} from "@/components/DashboardClient";
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

  const {
    state, freshness, findings, weekly, efficiency, feed, totals, nutrition,
    pace, vo2max, calendar, today,
  } = data;
  const bestPace = pace.length
    ? pace.reduce((a, b) => (b.secPerKm < a.secPerKm ? b : a))
    : null;
  const { protein, phaseTrend } = nutrition;
  const currentPhase = nutrition.phases.at(-1) ?? null;
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
          <InstallButton />
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
            <span className="lbl">Trends</span>
            <span className="lbl meta">{totals.activities} activities on file</span>
          </div>

          <div className="charts">
            <AskLink question="Why did my training load change over the last few months?">
              <div className="chart-head">
                <span className="lbl">Weekly load</span>
                <span className="chart-val">{state.weekLoad}</span>
              </div>
              <LoadBars weekly={weekly} />
              <div className="chart-note">
                bars, not a line — a zero week is zero, not interpolated
              </div>
            </AskLink>

            <AskLink question="How does my gym work compare with my running, week by week?">
              <div className="chart-head">
                <span className="lbl">Sessions · gym vs runs</span>
                <span className="chart-val">{state.weekSessions}</span>
              </div>
              <SportMix weekly={weekly} />
              <div className="chart-note">
                <span className="key key-brand">gym</span>
                <span className="key key-ok">runs</span>
                stacked, so the week&rsquo;s total is the bar&rsquo;s height
              </div>
            </AskLink>

            <AskLink question="Is my 5k pace improving?">
              <div className="chart-head">
                <span className="lbl">Run pace · min/km</span>
                <span className="chart-val">
                  {bestPace
                    ? `${Math.floor(bestPace.secPerKm / 60)}:${String(
                        Math.round(bestPace.secPerKm % 60),
                      ).padStart(2, "0")}`
                    : "—"}
                </span>
              </div>
              {pace.length > 0 ? (
                <PaceChart points={pace} />
              ) : (
                <div className="empty-chart">
                  <span>no runs with distance yet</span>
                </div>
              )}
              <div className="chart-note">
                higher is faster · dot size is distance · never joined into a line
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

            <AskLink question="What has my VO2max done, and how current is that number?">
              <div className="chart-head">
                <span className="lbl">VO&#8322;max · estimated</span>
                <span className="chart-val">{state.vo2max ?? "—"}</span>
              </div>
              {vo2max.length > 0 ? (
                <SparseSeries
                  points={vo2max}
                  label="VO2max over time"
                  today={today}
                />
              ) : (
                <div className="empty-chart">
                  <span>no VO&#8322;max readings</span>
                  <span style={{ opacity: 0.7 }}>needs runs recorded on the watch</span>
                </div>
              )}
              <div className="chart-note">
                points only, and the axis runs to today — so a series that stopped
                visibly stopped
              </div>
            </AskLink>

            <AskLink
              question="How consistent has my training been over the last three months?"
              wide
            >
              <div className="chart-head">
                <span className="lbl">Training calendar · 12 weeks</span>
                <span className="lbl meta">
                  {calendar.length} day{calendar.length === 1 ? "" : "s"} with a session
                </span>
              </div>
              <TrainingCalendar days={calendar} today={today} />
              <div className="chart-note">
                one cell per day, shaded by load — an untrained day is an empty cell,
                not a missing one
              </div>
            </AskLink>
          </div>
        </section>

        {/*
          Nutrition is its own section rather than a row in the state strip,
          because it is the only data here the athlete has to produce by hand.
          Training data arrives whether or not they think about it; a food log
          exists only on the days they remembered. Mixing the two would let an
          unlogged day read like a measured one.
        */}
        <section className="sec">
          <div className="sec-head">
            <span className="lbl">Body &amp; intake</span>
            <span className="lbl meta">
              {protein.loggedDays} of {protein.windowDays} days logged
            </span>
          </div>

          <BodyForm
            latestKg={nutrition.latestWeight?.weightKg ?? null}
            latestOn={nutrition.latestWeight?.date ?? null}
            phase={currentPhase}
          />

          <div className="readouts">
            <Row
              label="Protein · 7d"
              value={
                protein.eligible ? (
                  <>
                    {protein.gPerKg}
                    <span className="unit"> g/kg</span>
                  </>
                ) : (
                  "—"
                )
              }
              note={
                protein.eligible
                  ? `${protein.meanProteinG} g/day over ${protein.loggedDays} logged days`
                  : protein.reason
              }
              noteClass={protein.eligible ? undefined : "dormant"}
              isVoid={!protein.eligible}
            />

            <Row
              label="Intake · logged days"
              value={
                protein.meanKcal != null ? (
                  <>
                    {protein.meanKcal}
                    <span className="unit"> kcal</span>
                  </>
                ) : (
                  "—"
                )
              }
              note={
                protein.meanKcal != null
                  ? `mean of the days you logged — not a daily average${
                      protein.estimatedShare
                        ? `; ${Math.round(protein.estimatedShare * 100)}% estimated`
                        : ""
                    }`
                  : protein.loggedDays === 0
                    ? "no meals logged in the last 7 days"
                    : // Not the same sentence as "nothing logged", and the
                      // difference is the whole point of the panel: one logged
                      // day is data, it is just not a week.
                      `${protein.loggedDays} of ${protein.windowDays} days logged — too few to average`
              }
              noteClass="dormant"
              isVoid={protein.meanKcal == null}
            />

            <Row
              label={
                phaseTrend.phase ? `Trend · ${phaseTrend.phase}` : "Trend · phase"
              }
              value={
                phaseTrend.eligible ? (
                  <>
                    {phaseTrend.kgPerWeek! > 0 ? "+" : ""}
                    {phaseTrend.kgPerWeek}
                    <span className="unit"> kg/wk</span>
                  </>
                ) : (
                  "—"
                )
              }
              note={
                phaseTrend.eligible
                  ? `${phaseTrend.readings} weigh-ins over ${phaseTrend.spanDays}d${
                      phaseTrend.agrees === false
                        ? ` — opposite to a ${phaseTrend.phase}`
                        : ""
                    }`
                  : phaseTrend.reason
              }
              noteClass={
                phaseTrend.eligible && phaseTrend.agrees === false
                  ? "warn"
                  : "dormant"
              }
              isVoid={!phaseTrend.eligible}
            />
          </div>

          <div className="charts">
            <AskLink question="How has my weight moved within my current phase?">
              <div className="chart-head">
                <span className="lbl">Weight by phase</span>
                <span className="lbl meta">
                  {nutrition.weight.length} weigh-ins
                </span>
              </div>
              {nutrition.weight.length > 0 ? (
                <WeightChart points={nutrition.weight} />
              ) : (
                <div className="void-box">
                  no weigh-ins yet
                  <span>log one above and the trend starts here</span>
                </div>
              )}
              <div className="chart-note">
                The line breaks at every phase boundary. A single trend through
                a bulk and the cut after it would describe neither.
              </div>
            </AskLink>

            <AskLink question="What did I eat this week, and how much protein was in it?">
              <div className="chart-head">
                <span className="lbl">Recent meals</span>
                <span className="lbl meta">computed from stored composition</span>
              </div>
              {nutrition.recentMeals.length > 0 ? (
                <ul className="meal-list">
                  {nutrition.recentMeals.map((m) => (
                    <li key={m.id}>
                      <span className="num">{m.eatenOn}</span>
                      <span className="meal-list-sep">·</span>
                      <span className="num">{m.kcal} kcal</span>
                      <span className="meal-list-sep">·</span>
                      <span className="num">{m.proteinG} g protein</span>
                      {m.estimatedShare > 0.5 && (
                        <span className="chip skip">mostly estimated</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="void-box">
                  nothing logged
                  <span>tap Ask, then describe or photograph a meal</span>
                </div>
              )}
            </AskLink>
          </div>
        </section>

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

        <p className="note">
          Every figure here is computed in SQL or by the analysis engine —
          nothing on this page is estimated. {totals.notifications} judgments
          recorded, {totals.sent} delivered. Tap <b>Ask</b> to put questions to
          the same data.
        </p>
      </main>
    </>
  );
}
