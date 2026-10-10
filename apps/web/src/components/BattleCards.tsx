import { Link, Icon, Agent, Status, date, duration, names, number } from '../lib/common.js'
import type { BattleSummary } from '../lib/common.js'

export function BattleCards({ battles }: { battles: BattleSummary[] }) {
  return (
    <div className="battle-cards">
      {battles.map((battle) => (
        <Link key={battle.id} to={`/battles/${battle.id}`} className="battle-card">
          <div className="battle-card-top">
            <span className="eyebrow">
              {battle.sessionIds.length} AGENTS · {battle.repositoryName}
            </span>
            <Icon name="arrow" />
          </div>
          <h3>{battle.task ?? 'Task prompt not stored'}</h3>
          <div className="battle-card-agents">
            {battle.participants.map((participant) => (
              <span className="battle-card-agent" key={participant.id}>
                <Agent id={participant.agentId} />
                <strong
                  className={participant.id === battle.winnerSessionId ? 'text-teal' : undefined}
                >
                  {number(participant.score)}
                </strong>
              </span>
            ))}
          </div>
          <div className="battle-card-result">
            <span>
              <Icon name="trophy" size={13} />
              {battle.winnerSessionId
                ? `Winner: ${names[battle.participants.find((p) => p.id === battle.winnerSessionId)?.agentId ?? 'demo']}`
                : battle.tiedSessionIds.length
                  ? 'Exact tie'
                  : 'Winner pending'}
            </span>
            <span>
              <Icon name="clock" size={13} />
              {battle.durationMs === null ? 'In progress' : duration(battle.durationMs)}
            </span>
          </div>
          {battle.participants.some((participant) => participant.demo) && (
            <span className="mini-label battle-demo-label">EXPLICIT DEMO</span>
          )}
          <div className="battle-card-bottom">
            <Status status={battle.status} />
            <span>{date(battle.startedAt)}</span>
          </div>
        </Link>
      ))}
    </div>
  )
}
