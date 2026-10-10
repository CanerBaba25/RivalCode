import type { Page, Session } from '@rivalcode/shared'
import {
  Agent,
  Icon,
  Link,
  Score,
  State,
  Status,
  date,
  duration,
  names,
  useApi
} from '../lib/common.js'
import type { BattleSummary, OverviewData } from '../lib/common.js'

export function LatestBattleFocus({ battle }: { battle?: BattleSummary }) {
  const winner = battle?.participants.find(
    (participant) => participant.id === battle.winnerSessionId
  )
  const outcome =
    battle?.status === 'completed'
      ? winner
        ? `${names[winner.agentId]} won`
        : battle.tiedSessionIds.length
          ? 'Exact tie'
          : 'No eligible winner'
      : battle?.status === 'failed' || battle?.status === 'aborted'
        ? 'No eligible winner'
        : 'Outcome pending'

  return (
    <section className="panel latest-battle-focus" aria-labelledby="latest-battle-title">
      <div className="focus-heading">
        <div>
          <span className="eyebrow">LATEST COMPARISON</span>
          <h2 id="latest-battle-title">Latest battle</h2>
        </div>
        <Icon name="battle" size={24} />
      </div>
      {battle ? (
        <>
          <div className="focus-meta">
            <Status status={battle.status} />
            {battle.participants.some((participant) => participant.demo) && (
              <span className="demo-badge">Explicit demo</span>
            )}
            <span>{battle.repositoryName}</span>
          </div>
          <Link to={`/battles/${battle.id}`} className="focus-task">
            {battle.task ?? 'Task prompt not stored'}
          </Link>
          <div className="focus-participants">
            {battle.participants.map((participant) => (
              <div key={participant.id} className="focus-participant">
                <Agent id={participant.agentId} />
                <Score value={participant.score} />
              </div>
            ))}
          </div>
          <div className="focus-footer">
            <div className="focus-result">
              <strong>{outcome}</strong>
              <span className="subtext">
                {date(battle.startedAt)} · {duration(battle.durationMs)}
              </span>
            </div>
            <Link to={`/battles/${battle.id}`} className="button secondary">
              Open battle <Icon name="arrow" size={16} />
            </Link>
          </div>
        </>
      ) : (
        <div className="focus-empty">
          <h3>No battles recorded yet</h3>
          <p>Compare recorded sessions, or run the same task in isolated worktrees.</p>
          <Link to="/compare" className="button secondary">
            Choose sessions <Icon name="arrow" size={16} />
          </Link>
        </div>
      )}
    </section>
  )
}

export function ActiveRunsFocus({ active }: { active: number }) {
  const preparing = useApi<Page<Session>>(active ? '/api/sessions?status=preparing&limit=4' : null)
  const running = useApi<Page<Session>>(active ? '/api/sessions?status=running&limit=4' : null)
  const verifying = useApi<Page<Session>>(active ? '/api/sessions?status=verifying&limit=4' : null)
  const queries = [preparing, running, verifying]
  // A run can advance between independent status requests; keep one current card.
  const observed = queries.flatMap((query) => query.data?.items ?? [])
  const sessions = [...new Map(observed.map((session) => [session.id, session])).values()]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 3)
  const loading = queries.some((query) => query.loading)
  const error = queries.find((query) => query.error)?.error ?? null

  return (
    <section className="panel active-runs-focus" aria-labelledby="active-runs-title">
      <div className="focus-heading">
        <div>
          <span className="eyebrow">HAPPENING NOW</span>
          <h2 id="active-runs-title">
            Active runs <span className="focus-count">{active}</span>
          </h2>
        </div>
        <span className={`focus-live-dot ${active ? 'busy' : ''}`} aria-hidden="true" />
      </div>
      {active ? (
        <>
          <State
            loading={loading && !sessions.length}
            error={error}
            retry={() => queries.forEach((query) => query.retry())}
          />
          <div className="active-runs-list">
            {sessions.map((session) => (
              <Link to={`/sessions/${session.id}`} key={session.id} className="active-run-link">
                <div>
                  <Agent id={session.agentId} />
                  <strong>{session.task ?? 'Task prompt not stored'}</strong>
                  <span className="subtext">
                    {session.repositoryName} · Started {date(session.startedAt)}
                  </span>
                </div>
                <Status status={session.status} />
              </Link>
            ))}
          </div>
          {!loading && !error && !sessions.length && (
            <p className="muted">Run status is updating.</p>
          )}
          {active > sessions.length && sessions.length > 0 && (
            <p className="subtext">Showing the {sessions.length} most recent active runs.</p>
          )}
        </>
      ) : (
        <div className="focus-empty active-empty">
          <Icon name="check" size={28} />
          <h3>No agents running</h3>
          <p>New runs appear here automatically.</p>
        </div>
      )}
      <Link to="/sessions" className="text-link focus-all-link">
        View sessions <Icon name="arrow" size={16} />
      </Link>
    </section>
  )
}

export function OverviewActions({ data }: { data: OverviewData }) {
  const recent = data.recentSessions[0]
  const failure = data.recentFailures[0]
  const actions = [
    {
      to: recent ? `/sessions/${recent.id}` : '/agents',
      icon: recent ? 'sessions' : 'agents',
      title: recent ? 'Replay your latest run' : 'Check available agents',
      detail: recent
        ? 'Follow the recorded events and final changes.'
        : 'See installed adapters and capture capabilities.'
    },
    {
      to: '/compare',
      icon: 'battle',
      title: 'Compare recorded sessions',
      detail: 'Choose runs and inspect the evidence side by side.'
    },
    {
      to: failure ? `/sessions/${failure.id}` : '/leaderboard',
      icon: failure ? 'shield' : 'chart',
      title: failure ? 'Investigate the latest failure' : 'Explore your workload history',
      detail: failure
        ? 'Open failed checks and captured run evidence.'
        : 'Filter results by repository, dates and task tags.'
    }
  ]

  return (
    <nav className="overview-actions" aria-label="Useful next actions">
      {actions.map((action) => (
        <Link to={action.to} className="overview-action" key={action.title}>
          <span className="overview-action-icon">
            <Icon name={action.icon} />
          </span>
          <div>
            <strong>{action.title}</strong>
            <p>{action.detail}</p>
          </div>
          <Icon name="arrow" size={16} />
        </Link>
      ))}
    </nav>
  )
}
