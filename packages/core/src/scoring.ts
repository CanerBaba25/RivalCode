import type {
  Battle,
  Session,
  Score,
  RivalConfig,
  NormalizedEvent,
  Finding,
  VerificationRun,
  FileChange
} from '@rivalcode/shared'

export function scoreRun(
  input: {
    verification: VerificationRun[]
    files: FileChange[]
    findings: Finding[]
    events: NormalizedEvent[]
    durationMs: number
    exitCode: number | null
    aborted: boolean
  },
  config: RivalConfig
): Score {
  const final = input.verification.filter((v) => v.phase === 'final')
  const required = final.filter((v) => v.required)
  const verificationAvailable = required.length > 0
  const terminalFailure = input.events.some(
    (event) =>
      (event.type === 'error' || event.type === 'session_finished') && event.payload.fatal === true
  )
  const requiredPassed =
    verificationAvailable &&
    required.every((v) => v.passed) &&
    input.exitCode === 0 &&
    !input.aborted &&
    !terminalFailure
  const correctness = required.length
    ? Math.round((50 * required.filter((v) => v.passed).length) / required.length)
    : 0
  const health = final.filter((v) => /lint|typecheck|build/.test(v.checkId))
  const codeHealth = health.length
    ? Math.round((15 * health.filter((v) => v.passed).length) / health.length)
    : 0
  const forbidden = input.findings.some((f) => f.type === 'forbidden_path')
  const large = input.findings.some((f) => f.type === 'large_patch')
  const failedToolIds = new Set(
    input.events
      .filter(
        (event) =>
          (event.type === 'command_finished' || event.type === 'tool_finished') &&
          (event.payload.failed === true ||
            event.payload.success === false ||
            (typeof event.payload.exitCode === 'number' && event.payload.exitCode !== 0))
      )
      .map((event) => event.payload.toolId)
      .filter((id) => typeof id === 'string')
  )
  const failures = input.events.filter(
    (e) =>
      (e.type === 'error' &&
        e.payload.severity !== 'warning' &&
        !failedToolIds.has(e.payload.toolId as string)) ||
      (e.type === 'command_finished' &&
        (e.payload.failed === true ||
          e.payload.success === false ||
          (typeof e.payload.exitCode === 'number' && e.payload.exitCode !== 0))) ||
      (e.type === 'tool_finished' && (e.payload.failed === true || e.payload.success === false))
  ).length
  const repeats = input.findings.filter((f) => f.type === 'repeated_failure').length
  const changeDiscipline = Math.max(0, 15 - (forbidden ? 10 : 0) - (large ? 5 : 0))
  const reliability =
    input.aborted || input.exitCode !== 0 || terminalFailure
      ? 0
      : Math.max(0, 10 - Math.min(8, failures) - repeats * 2)
  const budget = Math.max(1, config.battle.timeoutMinutes * 60000)
  const efficiency = Math.max(
    0,
    Math.round(10 * Math.max(0, 1 - input.durationMs / budget)) - Math.min(4, repeats)
  )
  const raw = correctness + codeHealth + changeDiscipline + reliability + efficiency
  const total = !requiredPassed ? Math.min(49, raw) : raw
  return {
    total,
    correctness,
    codeHealth,
    changeDiscipline,
    reliability,
    efficiency,
    requiredPassed,
    verificationAvailable,
    explanation: [
      `Correctness: ${correctness}/50 from ${required.filter((v) => v.passed).length}/${required.length} required checks.`,
      `Code health: ${codeHealth}/15 from configured lint, typecheck and build checks.`,
      `Change discipline: ${changeDiscipline}/15; forbidden paths and patch thresholds are measured.`,
      `Reliability: ${reliability}/10 from process and observable failures.`,
      `Efficiency: ${efficiency}/10 relative to the configured timeout.`,
      ...(!verificationAvailable
        ? ['No required verification configured: correctness is unmeasured; score capped at 49.']
        : !requiredPassed
          ? ['Required verification or agent execution failed; score capped at 49.']
          : [])
    ]
  }
}

function compare(a: Session, b: Session): number {
  const eligible = eligibleSession
  const failures = (s: Session) =>
    s.verification.filter((v) => v.phase === 'final' && !v.passed).length
  const patch = (s: Session) => s.files.reduce((sum, f) => sum + f.additions + f.deletions, 0)
  return (
    Number(eligible(b)) - Number(eligible(a)) ||
    (b.score?.total ?? -1) - (a.score?.total ?? -1) ||
    failures(a) - failures(b) ||
    a.durationMs - b.durationMs ||
    patch(a) - patch(b)
  )
}
export function rankBattle(
  sessions: Session[]
): Pick<Battle, 'winnerSessionId' | 'tiedSessionIds' | 'ranking'> {
  const sorted = [...sessions].sort(compare)
  let rank = 1
  const ranking = sorted.map((s, i) => {
    if (i && compare(sorted[i - 1]!, s)) rank = i + 1
    return { sessionId: s.id, rank }
  })
  const top = sorted[0]
  if (!top || !eligibleSession(top)) return { winnerSessionId: null, tiedSessionIds: [], ranking }
  const ties = sorted.filter((s) => compare(top, s) === 0).map((s) => s.id)
  return {
    winnerSessionId: ties.length === 1 ? top.id : null,
    tiedSessionIds: ties.length > 1 ? ties : [],
    ranking
  }
}

function eligibleSession(session: Session): boolean {
  const required = session.verification.filter((check) => check.phase === 'final' && check.required)
  return (
    session.status === 'completed' &&
    session.exitCode === 0 &&
    required.length > 0 &&
    required.every((check) => check.passed)
  )
}
