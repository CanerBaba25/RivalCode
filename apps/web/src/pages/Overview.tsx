import {
  Link,
  Icon,
  Agent,
  State,
  Empty,
  PageHeading,
  Panel,
  Metric,
  useApi,
  names,
  duration,
  number
} from '../lib/common.js'
import type { OverviewData } from '../lib/common.js'
import { SessionTable } from '../components/SessionTable.js'
import { ActiveRunsFocus, LatestBattleFocus, OverviewActions } from '../components/OverviewFocus.js'
import { OutcomePanel, UsageCoverage, overviewRates } from '../components/OverviewInsights.js'

export function Overview() {
  const query = useApi<OverviewData>('/api/overview')
  const data = query.data
  const rates = data ? overviewRates(data) : null
  const demoPresent =
    data &&
    (data.recentSessions.some((session) => session.demo) ||
      data.agentUsage.some((usage) => usage.agentId === 'demo') ||
      data.recentBattles.some((battle) =>
        battle.participants.some((participant) => participant.demo)
      ))

  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE SNAPSHOT"
        title="Workspace overview"
        actions={
          <Link to="/compare" className="button primary">
            <Icon name="battle" />
            Compare sessions
            <Icon name="arrow" size={16} />
          </Link>
        }
      >
        Recorded outcomes, current runs and your latest comparison.
      </PageHeading>
      <State {...query} />
      {data && rates && (
        <>
          {demoPresent && (
            <div className="demo-notice">
              <strong>Explicit demo fixtures are present</strong> · Overview totals include labeled
              demo runs.
            </div>
          )}
          <div className="metrics overview-metrics">
            <Metric
              label="Recorded sessions"
              value={number(data.totalSessions)}
              detail={`${number(rates.finished)} finished · ${number(data.activeSessions)} active`}
              icon="sessions"
            />
            <Metric
              label="Success rate"
              value={
                <span className="text-teal">
                  {rates.successRate === null ? 'N/A' : `${number(rates.successRate)}%`}
                </span>
              }
              detail={`${number(data.successfulSessions)} successful / ${number(rates.finished)} finished runs`}
              icon="check"
            />
            <Metric
              label="Active now"
              value={number(data.activeSessions)}
              detail="Preparing, running or verifying"
              icon="clock"
            />
            <Metric
              label="Average duration"
              value={duration(data.averageDurationMs)}
              detail="Across recorded sessions"
              icon="clock"
            />
          </div>
          <div className="overview-focus-grid">
            <LatestBattleFocus battle={data.recentBattles[0]} />
            <ActiveRunsFocus active={data.activeSessions} />
          </div>
          <OverviewActions data={data} />
          <div className="overview-insights-grid">
            <OutcomePanel data={data} />
            <UsageCoverage data={data} />
          </div>
          <div className="overview-grid">
            <Panel title="Agent activity" hint="Recorded workloads on your machine">
              {data.agentUsage.length ? (
                <div className="usage-bars">
                  {data.agentUsage.map((usage) => (
                    <div key={usage.agentId} className="usage-row">
                      <div>
                        <Agent id={usage.agentId} />
                        <span>
                          {usage.runs} {usage.runs === 1 ? 'run' : 'runs'}
                        </span>
                      </div>
                      <div className="bar-track">
                        <div
                          className={`bar-fill ${usage.agentId}`}
                          style={{
                            width: `${(100 * usage.runs) / Math.max(...data.agentUsage.map((item) => item.runs), 1)}%`
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted inset">Activity appears after a recorded run.</p>
              )}
            </Panel>
            <Panel title="Recent failures" hint="Evidence worth investigating">
              {data.recentFailures.length ? (
                <div className="failure-list">
                  {data.recentFailures.map((session) => (
                    <Link to={`/sessions/${session.id}`} key={session.id}>
                      <span className="failure-mark">!</span>
                      <div>
                        <strong>{session.task ?? 'Task prompt not stored'}</strong>
                        <span className="subtext">
                          {names[session.agentId]} ·{' '}
                          {session.error ?? `${session.findings.length} findings`}
                        </span>
                        {session.demo && <span className="demo-badge">Explicit demo</span>}
                      </div>
                      <Icon name="arrow" size={16} />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="clear-state">
                  <Icon name="shield" size={36} />
                  <h3>No recorded failures</h3>
                  <p>Failed checks and interrupted runs appear here.</p>
                </div>
              )}
            </Panel>
          </div>
          <Panel
            title="Recent sessions"
            hint="Open a run to inspect its captured evidence"
            action={
              <Link to="/sessions" className="text-link">
                All sessions
                <Icon name="arrow" size={16} />
              </Link>
            }
          >
            {data.recentSessions.length ? (
              <SessionTable sessions={data.recentSessions} />
            ) : (
              <Empty title="No sessions recorded yet">
                <p>Check your installed agents, then capture a task from your repository.</p>
                <Link to="/agents" className="button secondary">
                  View available agents
                  <Icon name="arrow" size={16} />
                </Link>
              </Empty>
            )}
          </Panel>
        </>
      )}
    </>
  )
}
