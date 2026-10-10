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
  number,
  cost
} from '../lib/common.js'
import type { OverviewData } from '../lib/common.js'
import { SessionTable } from '../components/SessionTable.js'
import { BattleCards } from '../components/BattleCards.js'

export function Overview() {
  const query = useApi<OverviewData>('/api/overview')
  const data = query.data
  return (
    <>
      <PageHeading
        eyebrow="YOUR PERSONAL BENCHMARK LAB"
        title="See what your agents actually do."
        actions={
          <Link to="/battles" className="button primary">
            <Icon name="battle" />
            Open the arena
            <Icon name="arrow" size={16} />
          </Link>
        }
      >
        Measure outcomes. Replay the work. Compare on your own code.
      </PageHeading>
      <State {...query} />
      {data && (
        <>
          {data.recentSessions.some((session) => session.demo) && (
            <div className="demo-notice">
              <strong>Explicit demo fixtures are present</strong> · Demo runs are labeled in each
              session. Overview totals include all recorded runs, including these fixtures.
            </div>
          )}
          <div className="metrics">
            <Metric
              label="Recorded sessions"
              value={number(data.totalSessions)}
              detail={`${data.activeSessions} active now`}
              icon="sessions"
            />
            <Metric
              label="Successful sessions"
              value={<span className="text-teal">{number(data.successfulSessions)}</span>}
              detail={`${data.failedSessions} failed or interrupted`}
              icon="check"
            />
            <Metric
              label="Average duration"
              value={duration(data.averageDurationMs)}
              detail="Across recorded sessions"
              icon="clock"
            />
            <Metric
              label="Available token usage"
              value={number(data.totalTokens)}
              detail={`${data.tokensAvailableRuns} of ${data.totalSessions} runs with usage`}
              icon="code"
            />
            <Metric
              label="Recorded cost"
              value={cost(data.totalCostUsd, data.costType)}
              detail={
                <>
                  {data.costAvailableRuns} runs ·{' '}
                  {data.costType === 'estimated'
                    ? 'includes API-equivalent estimates*'
                    : data.costType === 'provider_reported'
                      ? 'provider reported'
                      : 'not available'}
                </>
              }
              icon="chart"
            />
          </div>
          <div className="section-title">
            <div>
              <div className="eyebrow">SAME TASK. SAME COMMIT.</div>
              <h2>Recent battles</h2>
            </div>
            <Link to="/battles" className="text-link">
              View all
              <Icon name="arrow" size={16} />
            </Link>
          </div>
          {data.recentBattles.length ? (
            <BattleCards battles={data.recentBattles} />
          ) : (
            <Empty title="Your first comparison starts here">
              <p>Run agents against the same task in isolated Git worktrees.</p>
              <code>rivalcode battle --agents codex,claude --task "Add rate limiting"</code>
            </Empty>
          )}
          <div className="overview-grid">
            <Panel title="Agent activity" hint="Recorded workloads on your machine">
              {data.agentUsage.length ? (
                <div className="usage-bars">
                  {data.agentUsage.map((usage) => (
                    <div key={usage.agentId} className="usage-row">
                      <div>
                        <Agent id={usage.agentId} />
                        <span>{usage.runs} runs</span>
                      </div>
                      <div className="bar-track">
                        <div
                          className={`bar-fill ${usage.agentId}`}
                          style={{
                            width: `${(100 * usage.runs) / Math.max(...data.agentUsage.map((u) => u.runs), 1)}%`
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted inset">Agent usage appears after a recorded run.</p>
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
                      </div>
                      <Icon name="arrow" size={16} />
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="clear-state">
                  <Icon name="shield" size={36} />
                  <h3>No recorded failures</h3>
                  <p>Failed checks and interrupted runs will appear here.</p>
                </div>
              )}
            </Panel>
          </div>
          <Panel
            title="Recent sessions"
            hint="Results backed by local verification"
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
                <p>Capture your first run with an installed agent:</p>
                <code>rivalcode run codex --task "Add a health endpoint"</code>
                <p>
                  From a source checkout, generate explicit labeled fixtures with{' '}
                  <code>pnpm demo</code>.
                </p>
              </Empty>
            )}
          </Panel>
          {data.costType === 'estimated' && (
            <p className="footnote">
              * Estimates use configured API-equivalent pricing. They do not represent subscription
              charges.
            </p>
          )}
        </>
      )}
    </>
  )
}
