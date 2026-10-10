import type { Session, Battle } from '@rivalcode/shared'
import {
  Link,
  Icon,
  Status,
  State,
  PageHeading,
  ExportLinks,
  useApi,
  names,
  date,
  shortId
} from '../lib/common.js'
import { Comparison } from '../components/Comparison.js'
import { eligibleParticipant, recordedWinner } from '../lib/comparison.js'

export { checkResult } from '../lib/comparison.js'
export { BattleEvidence } from '../components/Comparison.js'
export type { EvidenceSelection } from '../components/Comparison.js'
export type BattleDetailData = Battle & { sessions: Session[] }

export function BattleDetail({ id }: { id: string }) {
  const query = useApi<BattleDetailData>(`/api/battles/${id}`)
  const battle = query.data
  const sessions = battle?.sessions ?? []
  const finalized = Boolean(battle && ['completed', 'failed', 'aborted'].includes(battle.status))
  const winner = recordedWinner(sessions, battle?.winnerSessionId ?? undefined, finalized)
  const ties = finalized
    ? sessions.filter(
        (session) => battle?.tiedSessionIds.includes(session.id) && eligibleParticipant(session)
      )
    : []

  return (
    <>
      <Link className="back-link" to="/battles">
        ← All battles
      </Link>
      <State {...query} />
      {battle && (
        <>
          <PageHeading
            eyebrow={`BATTLE ${shortId(battle.id).toUpperCase()} · ${battle.repositoryName.toUpperCase()}`}
            title={battle.task ?? 'Task prompt not stored'}
            actions={<ExportLinks id={id} />}
          >
            {date(battle.startedAt)} · <Status status={battle.status} />
          </PageHeading>
          <div className="arena-banner">
            <div className="arena-banner-icon">
              <Icon name="battle" size={36} />
            </div>
            <div>
              <strong>
                One task. One starting point. {sessions.length} independent{' '}
                {sessions.length === 1 ? 'run' : 'runs'}.
              </strong>
              <p>
                Base <code>{battle.baseCommit.slice(0, 12)}</code> · isolated worktrees · identical
                verification
              </p>
            </div>
            <span className="mini-label">LOCAL WORKLOAD</span>
          </div>
          {sessions.some((session) => session.demo) && (
            <div className="demo-notice">
              <strong>Explicit demo fixtures</strong> · Synthetic agent output for exploring
              RivalCode; these are not paid-agent benchmark results.
            </div>
          )}

          <Comparison
            sessions={sessions}
            winnerSessionId={battle.winnerSessionId ?? undefined}
            tiedSessionIds={battle.tiedSessionIds}
            ranking={battle.ranking}
            finalized={finalized}
          />

          <div className={`winner-banner ${winner ? '' : 'neutral'}`}>
            <span className="winner-icon">
              <Icon name="trophy" size={32} />
            </span>
            <div>
              <div className="eyebrow">
                {winner ? 'THIS WORKLOAD’S WINNER' : ties.length > 1 ? 'EXACT TIE' : 'RESULT'}
              </div>
              <h2>
                {winner
                  ? `${names[winner.agentId]} · ${shortId(winner.id)}`
                  : ties.length > 1
                    ? ties
                        .map((session) => `${names[session.agentId]} · ${shortId(session.id)}`)
                        .join(' & ')
                    : !finalized
                      ? 'Comparison in progress'
                      : 'No eligible winner'}
              </h2>
              <p>
                {winner
                  ? `Score ${winner.score?.total ?? 'N/A'} · required checks passed`
                  : 'A winner is calculated only from eligible recorded runs and deterministic ranking.'}
              </p>
            </div>
            {winner && (
              <Link className="button primary" to={`/sessions/${winner.id}`}>
                Inspect winning run <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
          <p className="footnote">
            Ranking: required checks pass first, score, failed checks, duration, then patch size.
            Exact ties remain ties. This result describes this task on this repository; it is not a
            universal model ranking.
          </p>
        </>
      )}
    </>
  )
}
