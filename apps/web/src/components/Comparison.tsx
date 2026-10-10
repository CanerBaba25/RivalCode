import React, { useState } from 'react'
import type { Battle, Session } from '@rivalcode/shared'
import {
  Link,
  Icon,
  Agent,
  Status,
  Score,
  names,
  duration,
  number,
  cost,
  costProvenance,
  modelLabel,
  date,
  shortId
} from '../lib/common.js'
import {
  bestParticipants,
  baselineChanges,
  baselineChecks,
  checkComparabilityReason,
  checkPredicate,
  checkResult,
  comparisonMetrics,
  eligibleParticipant,
  eligibilityReason,
  failureObservationReason,
  finalChecks,
  isFinal,
  metricDifference,
  metricHasDifferences,
  metricNumber,
  rankedParticipants,
  recordedWinner,
  repeatedFailureFindings,
  requiredCheckSignature,
  requiredSummary,
  scoreComponents,
  selectReference
} from '../lib/comparison.js'
import type { ComparisonMetric, MetricKey } from '../lib/comparison.js'
import { Verification } from './Verification.js'
import { Findings } from './Findings.js'
import { EvidenceDialog } from './EvidenceDialog.js'

export interface ComparisonProps {
  sessions: Session[]
  winnerSessionId?: string
  tiedSessionIds?: string[]
  ranking?: Battle['ranking']
  finalized?: boolean
  title?: string
}

export type EvidenceSelection = { session: Session; metric: string }

function participantIdentifier(session: Session, sessions: Session[]): string {
  const abbreviated = shortId(session.id)
  const unique = !sessions.some(
    (other) => other.id !== session.id && shortId(other.id) === abbreviated
  )

  return unique ? abbreviated : session.id
}

function participantLabel(session: Session, sessions: Session[]): string {
  return `${names[session.agentId]} · ${participantIdentifier(session, sessions)}`
}

function metricValue(session: Session, metric: ComparisonMetric): React.ReactNode {
  const predicate = checkPredicate(metric.key)
  if (predicate) {
    const checks = finalChecks(session, metric.key)
    const result = checkResult(session, predicate)

    return (
      <>
        {result}
        {checks.length > 0 && (
          <span className="subtext">
            {checks.filter((check) => check.passed).length}/{checks.length} passed
          </span>
        )}
      </>
    )
  }

  const value = metricNumber(session, metric.key)
  if (metric.key === 'score') return <Score value={value} />
  if (metric.key === 'duration') return duration(value)
  if (metric.key === 'cost') return cost(value, session.usage.costType)
  if (metric.key === 'failures' && value !== undefined && failureObservationReason(session))
    return `≥${number(value)}`
  return number(value)
}

function Difference({
  session,
  reference,
  metric
}: {
  session: Session
  reference: Session
  metric: ComparisonMetric
}) {
  if (session.id === reference.id) return <span className="metric-delta neutral">Reference</span>

  if (checkPredicate(metric.key)) {
    const reason = checkComparabilityReason(session, reference, metric.key)
    return (
      <span className={`metric-delta ${reason ? 'unavailable' : 'neutral'}`}>
        {reason ?? 'Same check definitions'}
      </span>
    )
  }
  if (!metric.direction) return null

  const difference = metricDifference(session, reference, metric.key)
  if (difference.value === undefined)
    return (
      <span
        className="metric-delta unavailable"
        title={difference.reason}
        aria-label={`Not comparable: ${difference.reason}`}
      >
        Not comparable
        <span className="subtext">{difference.reason}</span>
      </span>
    )

  const value = difference.value
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  const absolute = Math.abs(value)
  const text =
    metric.key === 'duration'
      ? absolute < 1000 && absolute > 0
        ? `${number(absolute)} ms`
        : duration(absolute)
      : metric.key === 'cost'
        ? `$${absolute.toLocaleString(undefined, { minimumFractionDigits: 3, maximumSignificantDigits: 4 })}${session.usage.costType === 'estimated' ? '*' : ''}`
        : number(absolute)
  const favorable = metric.direction === 'higher' ? value > 0 : value < 0
  const tone = value === 0 ? 'neutral' : favorable ? 'positive' : 'negative'

  return (
    <span className={`metric-delta ${tone}`}>
      {sign}
      {text}
      {difference.percent !== undefined && value !== 0 && (
        <span>
          {' '}
          ({difference.percent > 0 ? '+' : ''}
          {number(difference.percent)}%)
        </span>
      )}
    </span>
  )
}

export function Comparison({
  sessions: providedSessions,
  winnerSessionId,
  tiedSessionIds = [],
  ranking,
  finalized = providedSessions.every(isFinal),
  title = 'Head to head'
}: ComparisonProps) {
  const [referenceId, setReferenceId] = useState<string>()
  const [showDifferences, setShowDifferences] = useState(true)
  const [showAllMetrics, setShowAllMetrics] = useState(false)
  const [differencesOnly, setDifferencesOnly] = useState(false)
  const [evidence, setEvidence] = useState<{ sessionId: string; metric: MetricKey } | null>(null)
  const sessions = rankedParticipants(providedSessions, ranking)
  const reference = selectReference(sessions, referenceId, winnerSessionId, finalized)
  const winner = recordedWinner(sessions, winnerSessionId, finalized)
  const selectedSession = sessions.find((session) => session.id === evidence?.sessionId)
  const keyMetrics: MetricKey[] = [
    'required',
    'tests',
    'score',
    'duration',
    'files',
    'tokens',
    'cost'
  ]
  const visibleMetrics = comparisonMetrics.filter(
    (metric) =>
      (showAllMetrics || keyMetrics.includes(metric.key)) &&
      (!differencesOnly || metricHasDifferences(sessions, metric.key))
  )
  const sameConditions = sessions.every(
    (session) =>
      session.repositoryId === sessions[0]?.repositoryId &&
      session.baseCommit === sessions[0]?.baseCommit &&
      session.task !== null &&
      !/\[REDACTED\]/.test(session.task) &&
      session.task === sessions[0]?.task &&
      requiredCheckSignature(session) === requiredCheckSignature(sessions[0]!) &&
      checkComparabilityReason(session, sessions[0]!, 'all') === undefined &&
      !checkComparabilityReason(session, sessions[0]!, 'required')
  )
  const metricBadges = finalized && (ranking || sameConditions)

  const rankLabel = (session: Session): string => {
    if (!ranking) return session.demo ? 'DEMO RUN' : 'RECORDED RUN'
    if (!finalized) return 'IN PROGRESS'
    if (winner?.id === session.id) return 'WINNER'
    if (eligibleParticipant(session) && tiedSessionIds.includes(session.id)) return 'TIED'
    return `RANK ${ranking.find((entry) => entry.sessionId === session.id)?.rank ?? '—'}`
  }

  if (!reference)
    return <p className="comparison-empty muted">No participant sessions have been recorded yet.</p>

  return (
    <>
      {!ranking && (
        <div className="context-note comparison-context">
          <Icon name="info" size={18} />
          <p>
            {sameConditions
              ? 'These runs share the recorded repository, base commit, task and final check definitions. Each retains its original execution conditions.'
              : 'These historical runs may use different tasks, repositories, base commits or checks. Their measurements are observations, not a controlled ranking.'}{' '}
            Selecting a reference changes the displayed differences only.
          </p>
        </div>
      )}
      {!ranking && sessions.some((session) => session.demo) && (
        <div className="demo-notice">
          <strong>Explicit demo runs</strong> · Demo participants use a deterministic local agent.
          These recordings are not paid-agent benchmark results.
        </div>
      )}

      <div className="comparison-summary" aria-label="Participant summaries">
        {sessions.map((session) => {
          const changes = baselineChanges(session)
          return (
            <article
              key={session.id}
              className={`participant-card panel ${winner?.id === session.id ? 'winner-column' : ''} ${reference.id === session.id ? 'reference-column' : ''}`}
            >
              <div className="participant-card-heading">
                <Agent id={session.agentId} />
                <Status status={session.status} />
              </div>
              <span className="participant-id mono">
                {participantIdentifier(session, sessions)}
              </span>
              <span className="subtext">{modelLabel(session.model, session.modelSource)}</span>
              <div className="participant-card-metrics">
                <div>
                  <span>Score</span>
                  <Score value={session.score?.total} />
                </div>
                <div>
                  <span>Required checks</span>
                  <strong>
                    {requiredSummary(session)}
                    {finalChecks(session, 'required').length > 0 ? ' passed' : ''}
                  </strong>
                </div>
              </div>
              <span className="subtext">
                {eligibilityReason(session) ?? 'Eligible recorded run'}
              </span>
              {changes.compared > 0 && (
                <span className="subtext">
                  Required baseline: {changes.improved} improved · {changes.regressed} regressed
                  {changes.unmatched > 0 && ` · ${changes.unmatched} unmatched`}
                </span>
              )}
              <span className="rank-label">{rankLabel(session)}</span>
              {reference.id === session.id && <span className="mini-label">REFERENCE RUN</span>}
              <Link
                className="text-link"
                to={`/sessions/${session.id}`}
                aria-label={`Replay ${participantLabel(session, sessions)}`}
              >
                Replay run <Icon name="arrow" size={16} />
              </Link>
            </article>
          )
        })}
      </div>

      <div className="comparison-panel panel">
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            <p>Inspect any result to open its recorded evidence.</p>
          </div>
          <span className="subtext">
            {sessions.length} {sessions.length === 1 ? 'participant' : 'participants'}
          </span>
        </div>
        <div className="comparison-controls">
          <label className="comparison-reference">
            Reference run
            <select
              aria-label="Reference run"
              value={reference.id}
              onChange={(event) => setReferenceId(event.target.value)}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {participantLabel(session, sessions)}
                </option>
              ))}
            </select>
          </label>
          <label className="comparison-toggle checkbox">
            <input
              type="checkbox"
              checked={showDifferences}
              onChange={(event) => setShowDifferences(event.target.checked)}
            />
            Show differences
          </label>
          <label className="comparison-toggle checkbox">
            <input
              type="checkbox"
              checked={differencesOnly}
              onChange={(event) => setDifferencesOnly(event.target.checked)}
            />
            Differing metrics only
          </label>
          <label className="comparison-toggle checkbox">
            <input
              type="checkbox"
              checked={showAllMetrics}
              onChange={(event) => setShowAllMetrics(event.target.checked)}
            />
            Show all metrics
          </label>
        </div>
        <p className="footnote inset">
          Signed differences are each run minus {participantLabel(reference, sessions)}. Unknown
          usage stays unavailable; a zero reference has no percentage difference.
        </p>
        <div className="table-wrap">
          <table className="comparison-table" aria-label="Run comparison">
            <thead>
              <tr>
                <th scope="col">Measured outcome</th>
                {sessions.map((session) => (
                  <th
                    scope="col"
                    key={session.id}
                    className={`${winner?.id === session.id ? 'winner-column' : ''} ${reference.id === session.id ? 'reference-column' : ''}`}
                  >
                    <Agent id={session.agentId} />
                    <span className="participant-id mono">
                      {participantIdentifier(session, sessions)}
                    </span>
                    <span className="rank-label">{rankLabel(session)}</span>
                    {reference.id === session.id && <span className="mini-label">REFERENCE</span>}
                  </th>
                ))}
              </tr>
            </thead>
            {(['Outcomes', 'Effort', 'Usage'] as const).map((group) => {
              const metrics = visibleMetrics.filter((metric) => metric.group === group)
              if (!metrics.length) return null

              return (
                <tbody key={group}>
                  <tr className="comparison-group">
                    <th colSpan={sessions.length + 1} scope="colgroup">
                      {group}
                    </th>
                  </tr>
                  {metrics.map((metric) => {
                    const best = metricBadges ? bestParticipants(sessions, metric) : []

                    return (
                      <tr
                        key={metric.key}
                        className={metric.key === 'score' ? 'score-row' : undefined}
                      >
                        <th scope="row">
                          <span>{metric.label}</span>
                          <span className="metric-description">{metric.description}</span>
                        </th>
                        {sessions.map((session) => {
                          const predicate = checkPredicate(metric.key)
                          const result = predicate ? checkResult(session, predicate) : undefined

                          return (
                            <td
                              key={session.id}
                              className={`${winner?.id === session.id ? 'winner-column' : ''} ${reference.id === session.id ? 'reference-column' : ''}`}
                            >
                              <button
                                className={`evidence-value ${result === 'PASS' ? 'pass' : result === 'FAIL' ? 'fail' : result === 'N/A' ? 'unavailable' : ''}`}
                                aria-label={`Inspect ${metric.label} for ${participantLabel(session, sessions)}`}
                                onClick={() =>
                                  setEvidence({ sessionId: session.id, metric: metric.key })
                                }
                              >
                                {metricValue(session, metric)}
                                {result === 'PASS' && <Icon name="check" size={14} />}
                              </button>
                              {showDifferences && (
                                <Difference
                                  session={session}
                                  reference={reference}
                                  metric={metric}
                                />
                              )}
                              {best.includes(session.id) && (
                                <span className="metric-best">
                                  {best.length > 1 ? 'Joint ' : ''}
                                  {metric.bestLabel}
                                </span>
                              )}
                              {metric.key === 'cost' && (
                                <span className="subtext">
                                  {costProvenance(session.usage.costType, session.usage.costUsd)}
                                </span>
                              )}
                              {!isFinal(session) && <span className="subtext">Provisional</span>}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              )
            })}
          </table>
        </div>
        {!visibleMetrics.length && (
          <p className="comparison-empty muted">
            The selected runs have no different metric values. Clear “Differing metrics only” to
            inspect all evidence.
          </p>
        )}
        <p className="footnote inset">
          Metric badges describe eligible runs with comparable recorded values. They do not change
          the saved ranking. Token differences require matching native model identities. Cost
          differences require matching provenance; estimates* are not subscription charges.
        </p>
      </div>

      <section className="component-comparison panel" aria-label="Score component comparison">
        <div className="panel-heading">
          <div>
            <h2>What shaped the score</h2>
            <p>
              Each bar uses its component maximum. Required failures can cap the total below the
              component sum.
            </p>
          </div>
        </div>
        <div className="comparison-summary">
          {sessions.map((session) => (
            <div key={session.id} className="participant-card">
              <h3>{participantLabel(session, sessions)}</h3>
              {scoreComponents.map((component) => {
                const value = session.score?.[component.key]
                const available =
                  typeof value === 'number' &&
                  Number.isFinite(value) &&
                  value >= 0 &&
                  value <= component.max
                const width = available
                  ? Math.max(0, Math.min(100, (value / component.max) * 100))
                  : 0

                return (
                  <div key={component.key} className="component-row">
                    <div>
                      <span>{component.label}</span>
                      <strong>
                        {available ? value : 'N/A'} / {component.max}
                      </strong>
                    </div>
                    <div
                      className="component-track"
                      role={available ? 'meter' : undefined}
                      aria-label={`${component.label} for ${participantLabel(session, sessions)}`}
                      aria-valuemin={available ? 0 : undefined}
                      aria-valuemax={available ? component.max : undefined}
                      aria-valuenow={available ? value : undefined}
                    >
                      <span style={{ width: `${width}%` }} />
                    </div>
                  </div>
                )
              })}
              <button
                className="text-link"
                onClick={() => setEvidence({ sessionId: session.id, metric: 'score' })}
                aria-label={`Inspect score calculation for ${participantLabel(session, sessions)}`}
              >
                Inspect calculation <Icon name="arrow" size={16} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {evidence && selectedSession && (
        <EvidenceDialog
          title={`${participantLabel(selectedSession, sessions)} · ${comparisonMetrics.find((metric) => metric.key === evidence.metric)?.label ?? 'Evidence'}`}
          close={() => setEvidence(null)}
        >
          <BattleEvidence selection={{ session: selectedSession, metric: evidence.metric }} />
        </EvidenceDialog>
      )}
    </>
  )
}

export function BattleEvidence({ selection }: { selection: EvidenceSelection }) {
  const { session, metric } = selection
  const predicate = checkPredicate(metric)
  const previousChecks = predicate ? baselineChecks(session, metric) : []
  const changes = predicate ? baselineChanges(session, metric) : undefined

  return (
    <>
      {predicate ? (
        <>
          <p className="muted">Independent final verification</p>
          <Verification runs={finalChecks(session, metric)} />
          {previousChecks.length > 0 ? (
            <details>
              <summary>
                Matching baseline checks · {changes?.improved} improved · {changes?.regressed}{' '}
                regressed
              </summary>
              <p className="muted">
                Changes compare the same check ID and command before and after the agent run.
                {changes?.unmatched
                  ? ` ${changes.unmatched} final checks have no unique matching baseline.`
                  : ''}
              </p>
              <Verification runs={previousChecks} />
            </details>
          ) : (
            <p className="muted">
              No matching baseline checks recorded. A before-and-after outcome is unavailable.
            </p>
          )}
        </>
      ) : ['files', 'added', 'removed'].includes(metric) ? (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Added</th>
                  <th>Removed</th>
                  <th>Kind</th>
                </tr>
              </thead>
              <tbody>
                {session.files.map((file) => (
                  <tr key={file.path}>
                    <td className="mono">{file.path}</td>
                    <td className="text-teal">+{file.additions}</td>
                    <td className="text-coral">−{file.deletions}</td>
                    <td>{file.binary ? 'binary' : file.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">These counts come from the saved final Git patch.</p>
        </>
      ) : metric === 'duration' ? (
        <dl className="usage-details">
          <div>
            <dt>Started</dt>
            <dd>{date(session.startedAt)}</dd>
          </div>
          <div>
            <dt>Finished</dt>
            <dd>
              {session.finishedAt
                ? date(session.finishedAt)
                : isFinal(session)
                  ? 'Finish time unavailable'
                  : 'Still active'}
            </dd>
          </div>
          <div>
            <dt>Measured duration</dt>
            <dd>
              {duration(metricNumber(session, 'duration'))} ({number(session.durationMs)} ms)
            </dd>
          </div>
        </dl>
      ) : metric === 'failures' ? (
        <>
          {failureObservationReason(session) && (
            <p className="muted">
              {failureObservationReason(session)}. Recorded findings are lower bounds and cannot
              establish zero repeated failures.
            </p>
          )}
          <Findings
            findings={repeatedFailureFindings(session)}
            inspect={() => {
              window.location.href = `/sessions/${session.id}`
            }}
          />
        </>
      ) : metric === 'score' ? (
        <>
          <Score value={session.score?.total} />
          {!session.score && (
            <p className="muted">No deterministic score was recorded for this run.</p>
          )}
          <ul className="score-explanations">
            {session.score?.explanation.map((explanation, index) => (
              <li key={index}>{explanation}</li>
            ))}
          </ul>
          <p className="muted">
            {scoreComponents
              .map(
                (component) =>
                  `${component.label} ${session.score?.[component.key] ?? 'N/A'}/${component.max}`
              )
              .join(' · ')}
            .
          </p>
        </>
      ) : (
        <dl className="usage-details">
          <div>
            <dt>Input tokens</dt>
            <dd>{number(session.usage.inputTokens)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{number(session.usage.outputTokens)}</dd>
          </div>
          <div>
            <dt>Reported total tokens</dt>
            <dd>{number(session.usage.totalTokens)}</dd>
          </div>
          <div>
            <dt>Token accounting scope</dt>
            <dd>
              {session.usage.tokenScope === 'session'
                ? 'Whole session'
                : session.usage.tokenScope === 'main-agent'
                  ? 'Main agent only (subagents excluded)'
                  : session.usage.tokenScope === undefined &&
                      session.agentId !== 'claude' &&
                      session.agentId !== 'demo'
                    ? 'Provider-reported totals'
                    : 'Unverified accounting scope'}
            </dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>{cost(session.usage.costUsd, session.usage.costType)}</dd>
          </div>
          <div>
            <dt>Cost type</dt>
            <dd>{costProvenance(session.usage.costType, session.usage.costUsd)}</dd>
          </div>
          <div>
            <dt>Pricing model</dt>
            <dd>{modelLabel(session.usage.model, session.usage.modelSource)}</dd>
          </div>
          <div>
            <dt>Token model scope</dt>
            <dd>
              {session.usage.modelScope === 'single'
                ? 'Single observed model'
                : session.usage.modelScope === 'mixed'
                  ? 'Multiple observed models'
                  : 'Unverified scope'}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{session.usage.source ?? 'unavailable'}</dd>
          </div>
        </dl>
      )}
      <div className="dialog-footer">
        <Link className="button secondary" to={`/sessions/${session.id}`}>
          Open session evidence <Icon name="arrow" size={16} />
        </Link>
      </div>
    </>
  )
}
