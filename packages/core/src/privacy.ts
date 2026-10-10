import type {
  Battle,
  NormalizedEvent,
  RepositoryRecord,
  RivalConfig,
  Session
} from '@rivalcode/shared'
import { makeEvent } from './events.js'

type Redactor = (value: unknown) => unknown

export function redactEvent(
  event: NormalizedEvent,
  config: RivalConfig,
  redact: Redactor
): NormalizedEvent | null {
  const safe = makeEvent(event, event.sessionId, event.agentId, config, redact)

  return safe ? { ...safe, id: event.id } : null
}

/** Keep generated identities usable when a short secret also appears in a UUID or timestamp. */
export function redactSession(session: Session, redact: Redactor, config?: RivalConfig): Session {
  const safe = redact(session) as Session

  return {
    ...safe,
    task: config?.privacy.storeTaskPrompt === false ? null : safe.task,
    id: session.id,
    repositoryId: session.repositoryId,
    agentId: session.agentId,
    baseCommit: session.baseCommit,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    status: session.status,
    battleId: session.battleId,
    modelSource: session.modelSource,
    usage: {
      ...safe.usage,
      costType: session.usage.costType,
      modelSource: session.usage.modelSource
    },
    files: safe.files.map((file, index) => ({ ...file, status: session.files[index]!.status })),
    findings: safe.findings.map((finding, index) => {
      const original = session.findings[index]!

      return {
        ...finding,
        id: original.id,
        type: original.type,
        severity: original.severity,
        evidence: {
          ...finding.evidence,
          eventIds: original.evidence.eventIds,
          checkIds: original.evidence.checkIds
        }
      }
    }),
    verification: safe.verification.map((check, index) => {
      const original = session.verification[index]!

      return {
        ...check,
        id: original.id,
        sessionId: original.sessionId,
        phase: original.phase,
        startedAt: original.startedAt,
        finishedAt: original.finishedAt
      }
    })
  }
}

export function redactRepository(repository: RepositoryRecord, redact: Redactor): RepositoryRecord {
  return {
    ...(redact(repository) as RepositoryRecord),
    id: repository.id,
    projectType: repository.projectType,
    createdAt: repository.createdAt
  }
}

export function redactBattle(battle: Battle, redact: Redactor, config?: RivalConfig): Battle {
  const safe = redact(battle) as Battle
  const pricing: Battle['config']['pricing'] = {}

  for (const [model, price] of Object.entries(battle.config.pricing)) {
    const label = String(redact(model))
    let key = label
    let suffix = 1
    while (Object.hasOwn(pricing, key)) key = `${label} #${++suffix}`
    Object.defineProperty(pricing, key, {
      value: { ...price },
      enumerable: true,
      configurable: true,
      writable: true
    })
  }

  return {
    ...safe,
    task: config?.privacy.storeTaskPrompt === false ? null : safe.task,
    config: { ...safe.config, pricing },
    id: battle.id,
    repositoryId: battle.repositoryId,
    baseCommit: battle.baseCommit,
    startedAt: battle.startedAt,
    finishedAt: battle.finishedAt,
    status: battle.status,
    sessionIds: [...battle.sessionIds],
    winnerSessionId: battle.winnerSessionId,
    tiedSessionIds: [...battle.tiedSessionIds],
    ranking: battle.ranking.map((entry) => ({ ...entry }))
  }
}
