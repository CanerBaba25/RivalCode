import type { Battle, Finding, Session, VerificationRun } from '@rivalcode/shared'

export type MetricKey =
  | 'required'
  | 'tests'
  | 'lint'
  | 'build'
  | 'score'
  | 'duration'
  | 'files'
  | 'added'
  | 'removed'
  | 'failures'
  | 'tokens'
  | 'cost'

export interface ComparisonMetric {
  key: MetricKey
  label: string
  description: string
  group: 'Outcomes' | 'Effort' | 'Usage'
  direction?: 'higher' | 'lower'
  bestLabel?: string
}

export const comparisonMetrics: ComparisonMetric[] = [
  {
    key: 'required',
    label: 'Required checks',
    description: 'Required checks recorded in independent final verification',
    group: 'Outcomes'
  },
  {
    key: 'tests',
    label: 'Tests',
    description: 'Final test checks, including Go and Cargo',
    group: 'Outcomes'
  },
  { key: 'lint', label: 'Lint', description: 'Final lint checks', group: 'Outcomes' },
  {
    key: 'build',
    label: 'Build',
    description: 'Final build and type checks',
    group: 'Outcomes'
  },
  {
    key: 'score',
    label: 'Deterministic score',
    description: 'Recorded components; required failures cap the total at 49',
    group: 'Outcomes',
    direction: 'higher',
    bestLabel: 'Highest score'
  },
  {
    key: 'duration',
    label: 'Duration',
    description: 'Measured wall-clock duration; active runs are provisional',
    group: 'Effort',
    direction: 'lower',
    bestLabel: 'Fastest'
  },
  {
    key: 'files',
    label: 'Files changed',
    description: 'Saved final Git changes; fewer files is not proof of quality',
    group: 'Effort',
    direction: 'lower',
    bestLabel: 'Fewest files'
  },
  {
    key: 'added',
    label: 'Lines added',
    description: 'Saved final Git additions',
    group: 'Effort',
    direction: 'lower',
    bestLabel: 'Fewest additions'
  },
  {
    key: 'removed',
    label: 'Lines removed',
    description: 'Saved final Git deletions',
    group: 'Effort',
    direction: 'lower',
    bestLabel: 'Fewest deletions'
  },
  {
    key: 'failures',
    label: 'Repeated failures',
    description: 'Repeated-failure findings supported by recorded evidence',
    group: 'Effort',
    direction: 'lower',
    bestLabel: 'Fewest repeats'
  },
  {
    key: 'tokens',
    label: 'Reported tokens',
    description: 'Differences require complete totals and the same native model',
    group: 'Usage',
    direction: 'lower',
    bestLabel: 'Fewest tokens'
  },
  {
    key: 'cost',
    label: 'Reported / estimated cost',
    description: 'Differences require complete costs with matching type and source',
    group: 'Usage',
    direction: 'lower',
    bestLabel: 'Lowest cost'
  }
]

export const scoreComponents = [
  { key: 'correctness', label: 'Correctness', max: 50 },
  { key: 'codeHealth', label: 'Code health', max: 15 },
  { key: 'changeDiscipline', label: 'Change discipline', max: 15 },
  { key: 'reliability', label: 'Reliability', max: 10 },
  { key: 'efficiency', label: 'Efficiency', max: 10 }
] as const

export const isFinal = (session: Session): boolean =>
  ['completed', 'failed', 'aborted'].includes(session.status)

export function checkPredicate(key: string): ((check: VerificationRun) => boolean) | undefined {
  if (key === 'required') return (check) => check.required
  const patterns: Record<string, RegExp> = {
    tests: /\b(test|tests|pytest|vitest|jest|mocha|unittest)\b/i,
    lint: /\b(lint|ruff|eslint|clippy)\b/i,
    build: /\b(build|typecheck|type check|tsc|compile|check types)\b/i
  }
  const pattern = patterns[key]

  return pattern
    ? (check) => pattern.test(`${check.checkId} ${check.command}`.replaceAll('_', ' '))
    : undefined
}

export function finalChecks(session: Session, key: string): VerificationRun[] {
  const predicate = checkPredicate(key)

  return predicate
    ? session.verification.filter((check) => check.phase === 'final' && predicate(check))
    : []
}

export function requiredCheckSignature(session: Session): string {
  return JSON.stringify(
    finalChecks(session, 'required')
      .map((check) => [check.checkId, check.command])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  )
}

export function checkResult(session: Session, filter: (check: VerificationRun) => boolean): string {
  const checks = session.verification.filter((check) => check.phase === 'final' && filter(check))

  if (!checks.length) return 'N/A'
  return checks.every((check) => check.passed) ? 'PASS' : 'FAIL'
}

export function requiredSummary(session: Session): string {
  const checks = finalChecks(session, 'required')

  return checks.length ? `${checks.filter((check) => check.passed).length}/${checks.length}` : 'N/A'
}

export function eligibleParticipant(session: Session): boolean {
  const required = finalChecks(session, 'required')

  return (
    session.status === 'completed' &&
    session.exitCode === 0 &&
    required.length > 0 &&
    required.every((check) => check.passed)
  )
}

export function recordedWinner(sessions: Session[], winnerId?: string, finalized = true) {
  return finalized
    ? sessions.find((session) => session.id === winnerId && eligibleParticipant(session))
    : undefined
}

export function selectReference(
  sessions: Session[],
  requestedId?: string,
  winnerId?: string,
  finalized = true
): Session | undefined {
  const requested = sessions.find((session) => session.id === requestedId)

  return (
    requested ??
    recordedWinner(sessions, winnerId, finalized) ??
    [...sessions].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)
    )[0]
  )
}

export function rankedParticipants(sessions: Session[], ranking?: Battle['ranking']): Session[] {
  return [...sessions].sort(
    (a, b) =>
      (ranking?.find((entry) => entry.sessionId === a.id)?.rank ?? 1000) -
        (ranking?.find((entry) => entry.sessionId === b.id)?.rank ?? 1000) ||
      a.startedAt.localeCompare(b.startedAt) ||
      a.id.localeCompare(b.id)
  )
}

export function repeatedFailureFindings(session: Session): Finding[] {
  return session.findings.filter((finding) => finding.type === 'repeated_failure')
}

const known = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export function metricNumber(session: Session, key: MetricKey): number | undefined {
  const value =
    key === 'score'
      ? session.score?.total
      : key === 'duration'
        ? session.durationMs
        : key === 'tokens'
          ? session.usage.totalTokens
          : key === 'cost'
            ? session.usage.costUsd
            : key === 'files'
              ? session.files.length
              : key === 'added'
                ? session.files.reduce((sum, file) => sum + file.additions, 0)
                : key === 'removed'
                  ? session.files.reduce((sum, file) => sum + file.deletions, 0)
                  : key === 'failures'
                    ? repeatedFailureFindings(session).length
                    : undefined

  return known(value) ? value : undefined
}

export function comparabilityReason(a: Session, b: Session, key: MetricKey): string | undefined {
  if (!isFinal(a) || !isFinal(b)) return 'Run still active'
  if (metricNumber(a, key) === undefined || metricNumber(b, key) === undefined)
    return 'Measurement unavailable'

  if (key === 'tokens' || key === 'cost') {
    if (a.status !== 'completed' || b.status !== 'completed') return 'Usage may be incomplete'
    if (key === 'tokens') {
      const aModel = a.usage.model ?? a.model
      const bModel = b.usage.model ?? b.model
      const aSource = a.usage.modelSource ?? a.modelSource
      const bSource = b.usage.modelSource ?? b.modelSource

      if (
        !aModel ||
        aModel.includes('[REDACTED]') ||
        aModel !== bModel ||
        aSource !== 'native' ||
        bSource !== 'native'
      )
        return 'Token model identities differ or are unverified'
    } else {
      const aUsage = a.usage
      const bUsage = b.usage

      if (
        !['estimated', 'provider_reported'].includes(aUsage.costType ?? '') ||
        aUsage.costType !== bUsage.costType
      )
        return 'Cost types differ or are unknown'
      if (
        !aUsage.source ||
        aUsage.source !== bUsage.source ||
        aUsage.source.includes('[REDACTED]') ||
        /mixed|incomplete|partial|unavailable|unspecified/i.test(aUsage.source)
      )
        return 'Cost sources differ or completeness is unverified'
    }
  }

  return undefined
}

export interface MetricDifference {
  value?: number
  percent?: number
  reason?: string
}

export function metricDifference(
  session: Session,
  reference: Session,
  key: MetricKey
): MetricDifference {
  const reason = comparabilityReason(session, reference, key)
  if (reason) return { reason }

  const value = metricNumber(session, key)! - metricNumber(reference, key)!
  const baseline = metricNumber(reference, key)!
  const percent = baseline > 0 ? (value / baseline) * 100 : undefined

  return { value, ...(percent !== undefined && Number.isFinite(percent) ? { percent } : {}) }
}

export function bestParticipants(sessions: Session[], metric: ComparisonMetric): string[] {
  if (!metric.direction) return []
  const eligible = sessions.filter(eligibleParticipant)
  if (eligible.length < 2) return []
  const first = eligible[0]!
  if (eligible.some((session) => comparabilityReason(session, first, metric.key))) return []

  const values = eligible.map((session) => metricNumber(session, metric.key)!)
  const best = metric.direction === 'higher' ? Math.max(...values) : Math.min(...values)

  return eligible
    .filter((session) => metricNumber(session, metric.key) === best)
    .map((session) => session.id)
}

export function metricHasDifferences(sessions: Session[], key: MetricKey): boolean {
  const signature = (session: Session) => {
    if (checkPredicate(key)) {
      const checks = finalChecks(session, key)
      return `${checks.filter((check) => check.passed).length}/${checks.length}`
    }
    const value = metricNumber(session, key)

    if (key === 'cost') return `${value}|${session.usage.costType}|${session.usage.source}`
    if (key === 'tokens')
      return `${value}|${session.usage.model ?? session.model}|${session.usage.modelSource ?? session.modelSource}`
    return String(value)
  }

  return new Set(sessions.map(signature)).size > 1
}
