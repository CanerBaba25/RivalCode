import {
  Link,
  Icon,
  Agent,
  Status,
  Score,
  State,
  PageHeading,
  ExportLinks,
  Metric,
  useApi,
  duration,
  number,
  cost,
  costProvenance,
  modelLabel,
  tokenAccountingLabel,
  date,
  shortId
} from '../lib/common.js'
import { useState } from 'react'
import type { Session, Finding } from '@rivalcode/shared'
import { Timeline } from '../components/Timeline.js'
import { DiffViewer } from '../components/DiffViewer.js'
import { Verification } from '../components/Verification.js'
import { Findings } from '../components/Findings.js'
import { EvidenceDialog } from '../components/EvidenceDialog.js'
import { isFinal } from '../lib/comparison.js'

export function SessionDetail({ id }: { id: string }) {
  const query = useApi<Session>(`/api/sessions/${id}`)
  const [tab, setTab] = useState('timeline')
  const [focusIds, setFocusIds] = useState<string[]>([])
  const [focusChecks, setFocusChecks] = useState<string[]>([])
  const [path, setPath] = useState('')
  const [findingWithoutEvidence, setFindingWithoutEvidence] = useState<Finding | null>(null)
  const session = query.data
  const inspect = (finding: Finding) => {
    if (finding.evidence.eventIds?.length) {
      setFocusIds(finding.evidence.eventIds)
      setTab('timeline')
    } else if (finding.evidence.checkIds?.length) {
      setFocusChecks(finding.evidence.checkIds)
      setTab('verification')
    } else if (finding.evidence.paths?.length) {
      setPath(finding.evidence.paths[0] ?? '')
      setTab('diff')
    } else setFindingWithoutEvidence(finding)
  }
  return (
    <>
      <Link className="back-link" to="/sessions">
        ← All sessions
      </Link>
      <State {...query} />
      {session && (
        <>
          <PageHeading
            eyebrow={`SESSION ${shortId(session.id).toUpperCase()}${session.demo ? ' · EXPLICIT DEMO FIXTURE' : ''}`}
            title={session.task ?? 'Task prompt not stored'}
            actions={<ExportLinks id={id} />}
          >
            {session.repositoryName} · {date(session.startedAt)} ·{' '}
            <Status status={session.status} />
          </PageHeading>
          <div className="session-summary">
            <div className="session-identity">
              <Agent id={session.agentId} />
              <span className="subtext">
                {modelLabel(session.model, session.modelSource)} ·{' '}
                {session.agentVersion ?? 'Version unavailable'}
              </span>
            </div>
            <div className="fidelity">
              <Icon name="shield" size={20} />
              <div>
                <strong>
                  Capture fidelity: {session.capabilities.structuredEvents ? 'High' : 'Standard'}
                </strong>
                <span>
                  {session.capabilities.structuredEvents
                    ? 'Native structured events + Git + verification'
                    : 'Process output + Git + verification'}
                </span>
              </div>
            </div>
            <div className="base-commit">
              <span className="subtext">Base commit</span>
              <code title={session.baseCommit}>{session.baseCommit.slice(0, 12) || 'N/A'}</code>
            </div>
          </div>
          {session.error && (
            <div className="notice error" role="status">
              <strong>Run evidence</strong>
              <p>{session.error}</p>
            </div>
          )}
          <div className="metrics detail-metrics">
            <Metric
              label="Deterministic score"
              value={<Score value={session.score?.total} />}
              detail={
                session.score?.verificationAvailable
                  ? 'Verification-backed components'
                  : 'Correctness verification unavailable'
              }
              icon="chart"
            />
            <Metric
              label="Duration"
              value={duration(session.durationMs)}
              detail={
                session.finishedAt
                  ? `Finished ${date(session.finishedAt)}`
                  : isFinal(session)
                    ? 'Finish time unavailable'
                    : 'Session is still active'
              }
              icon="clock"
            />
            <Metric
              label="Tokens / cost"
              value={number(session.usage.totalTokens)}
              detail={
                cost(session.usage.costUsd, session.usage.costType) +
                ` · ${costProvenance(session.usage.costType, session.usage.costUsd)}`
              }
              icon="code"
            />
            <Metric
              label="Changed files"
              value={session.files.length}
              detail={
                <>
                  <span className="text-teal">
                    +{number(session.files.reduce((sum, file) => sum + file.additions, 0))}
                  </span>{' '}
                  /{' '}
                  <span className="text-coral">
                    −{number(session.files.reduce((sum, file) => sum + file.deletions, 0))}
                  </span>{' '}
                  lines
                </>
              }
              icon="folder"
            />
          </div>
          <div
            className="session-tabs"
            role="tablist"
            aria-label="Session evidence"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              )
              const active = buttons.findIndex((button) => button === document.activeElement)
              if (active < 0) return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (active + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
                      buttons.length
              buttons[next]?.focus()
              buttons[next]?.click()
            }}
          >
            {[
              ['timeline', 'Timeline replay'],
              ['diff', `Final diff (${session.files.length})`],
              ['verification', `Verification (${session.verification.length})`],
              ['findings', `Findings (${session.findings.length})`],
              ['score', 'Score & usage']
            ].map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                id={`tab-${key}`}
                aria-controls={`panel-${key}`}
                onClick={() => setTab(key ?? 'timeline')}
              >
                {label}
              </button>
            ))}
          </div>
          <section
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="panel evidence-panel"
          >
            {tab === 'timeline' && (
              <Timeline
                session={session}
                focusIds={focusIds}
                onFile={(file) => {
                  setPath(file)
                  setTab('diff')
                }}
              />
            )}
            {tab === 'diff' && <DiffViewer session={session} selectedPath={path} />}{' '}
            {tab === 'verification' && (
              <>
                <div className="panel-heading">
                  <div>
                    <h2>Verification evidence</h2>
                    <p>Baseline, setup and final checks are labeled separately.</p>
                  </div>
                </div>
                <Verification runs={session.verification} highlighted={focusChecks} />
              </>
            )}
            {tab === 'findings' && <Findings findings={session.findings} inspect={inspect} />}{' '}
            {tab === 'score' && (
              <div className="score-detail">
                <h2>Transparent score breakdown</h2>
                {session.score ? (
                  <>
                    <div className="score-components">
                      {[
                        ['Correctness', session.score.correctness, 50],
                        ['Code health', session.score.codeHealth, 15],
                        ['Change discipline', session.score.changeDiscipline, 15],
                        ['Reliability', session.score.reliability, 10],
                        ['Efficiency', session.score.efficiency, 10]
                      ].map(([label, value, max]) => (
                        <div key={String(label)}>
                          <span>{label}</span>
                          <strong>
                            {value} <span className="muted">/ {max}</span>
                          </strong>
                        </div>
                      ))}
                    </div>
                    <ul className="score-explanations">
                      {session.score.explanation.map((explanation, index) => (
                        <li key={index}>{explanation}</li>
                      ))}
                    </ul>
                    <p className="footnote">
                      Required checks {session.score.requiredPassed ? 'passed' : 'did not pass'}.
                      Verification{' '}
                      {session.score.verificationAvailable ? 'was available' : 'was unavailable'}.
                    </p>
                  </>
                ) : (
                  <p className="muted">Score is not available for this session yet.</p>
                )}
                <h3>Reported usage</h3>
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
                    <dt>Cached input</dt>
                    <dd>{number(session.usage.cachedInputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Reported total tokens</dt>
                    <dd>{number(session.usage.totalTokens)}</dd>
                  </div>
                  <div>
                    <dt>Token accounting scope</dt>
                    <dd>{tokenAccountingLabel(session)}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>{cost(session.usage.costUsd, session.usage.costType)}</dd>
                  </div>
                  <div>
                    <dt>Cost provenance</dt>
                    <dd>{costProvenance(session.usage.costType, session.usage.costUsd)}</dd>
                  </div>
                  <div>
                    <dt>Pricing model</dt>
                    <dd>{modelLabel(session.usage.model, session.usage.modelSource)}</dd>
                  </div>
                  <div>
                    <dt>Usage source</dt>
                    <dd>{session.usage.source ?? 'unavailable'}</dd>
                  </div>
                </dl>
                <p className="footnote">
                  Costs are separate from scores. Estimates are API-equivalent values using
                  explicitly configured prices; subscription costs cannot be inferred.
                </p>
              </div>
            )}
          </section>
          {findingWithoutEvidence && (
            <EvidenceDialog
              title={findingWithoutEvidence.title}
              close={() => setFindingWithoutEvidence(null)}
            >
              <p>{findingWithoutEvidence.detail}</p>
              <p className="muted">This finding has no event, check or file references recorded.</p>
            </EvidenceDialog>
          )}
        </>
      )}
    </>
  )
}
