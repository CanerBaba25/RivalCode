import {
  Link,
  Icon,
  Agent,
  Status,
  Score,
  State,
  PageHeading,
  ExportLinks,
  useApi,
  names,
  duration,
  number,
  cost,
  date,
  shortId
} from '../lib/common.js'
import React, { useState } from 'react'
import type { Session, Battle, VerificationRun } from '@rivalcode/shared'
import { Verification } from '../components/Verification.js'
import { Findings } from '../components/Findings.js'
import { EvidenceDialog } from '../components/EvidenceDialog.js'

export function checkResult(session: Session, filter: (check: VerificationRun) => boolean): string {
  const checks = session.verification.filter((run) => run.phase === 'final' && filter(run))
  if (!checks.length) return 'N/A'
  return checks.every((check) => check.passed) ? 'PASS' : 'FAIL'
}
export type BattleDetailData = Battle & { sessions: Session[] }
export type EvidenceSelection = { session: Session; metric: string }
export function BattleDetail({ id }: { id: string }) {
  const query = useApi<BattleDetailData>(`/api/battles/${id}`)
  const [evidence, setEvidence] = useState<EvidenceSelection | null>(null)
  const battle = query.data
  const sessions = [...(battle?.sessions ?? [])].sort(
    (a, b) =>
      (battle?.ranking.find((r) => r.sessionId === a.id)?.rank ?? 1000) -
      (battle?.ranking.find((r) => r.sessionId === b.id)?.rank ?? 1000)
  )
  const winner = sessions.find((session) => session.id === battle?.winnerSessionId)
  const metrics: {
    key: string
    label: string
    description: string
    value: (session: Session) => React.ReactNode
  }[] = [
    {
      key: 'required',
      label: 'Required checks',
      description: 'Configured required checks from the final phase',
      value: (session) => checkResult(session, (check) => check.required)
    },
    {
      key: 'tests',
      label: 'Tests',
      description: 'Final checks labeled test in their ID or command',
      value: (session) =>
        checkResult(session, (check) =>
          /test|pytest|cargo test|go test/i.test(`${check.checkId} ${check.command}`)
        )
    },
    {
      key: 'lint',
      label: 'Lint',
      description: 'Final lint checks',
      value: (session) =>
        checkResult(session, (check) =>
          /lint|ruff|eslint/i.test(`${check.checkId} ${check.command}`)
        )
    },
    {
      key: 'build',
      label: 'Build',
      description: 'Final build / type checks',
      value: (session) =>
        checkResult(session, (check) =>
          /build|typecheck|tsc|compile/i.test(`${check.checkId} ${check.command}`)
        )
    },
    {
      key: 'duration',
      label: 'Duration',
      description: 'Measured session wall-clock duration',
      value: (session) => duration(session.durationMs)
    },
    {
      key: 'files',
      label: 'Files changed',
      description: 'Saved final Git changes',
      value: (session) => session.files.length
    },
    {
      key: 'added',
      label: 'Lines added',
      description: 'Saved final Git additions',
      value: (session) => number(session.files.reduce((sum, file) => sum + file.additions, 0))
    },
    {
      key: 'removed',
      label: 'Lines removed',
      description: 'Saved final Git deletions',
      value: (session) => number(session.files.reduce((sum, file) => sum + file.deletions, 0))
    },
    {
      key: 'failures',
      label: 'Repeated failures',
      description: 'Evidence-supported repeated failure findings',
      value: (session) =>
        session.findings.filter((finding) => /repeated.*fail|repeat.*fail/i.test(finding.type))
          .length
    },
    {
      key: 'tokens',
      label: 'Reported tokens',
      description: 'Available provider token usage',
      value: (session) => number(session.usage.totalTokens)
    },
    {
      key: 'cost',
      label: 'Reported / estimated cost',
      description: 'Separate from score; estimates marked *',
      value: (session) => cost(session.usage.costUsd, session.usage.costType)
    },
    {
      key: 'score',
      label: 'Deterministic score',
      description: 'Click to inspect components and calculation',
      value: (session) => <Score value={session.score?.total} />
    }
  ]
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
          <div className="comparison-panel panel">
            <div className="panel-heading">
              <div>
                <h2>Head to head</h2>
                <p>Click any result to inspect its recorded evidence.</p>
              </div>
              <span className="subtext">
                {sessions.length} {sessions.length === 1 ? 'participant' : 'participants'}
              </span>
            </div>
            <div className="table-wrap">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Measured outcome</th>
                    {sessions.map((session) => (
                      <th
                        key={session.id}
                        className={session.id === battle.winnerSessionId ? 'winner-column' : ''}
                      >
                        <Agent id={session.agentId} />
                        <span className="subtext">{session.model ?? 'Model not reported'}</span>
                        <span className="rank-label">
                          {session.id === battle.winnerSessionId
                            ? 'WINNER'
                            : battle.tiedSessionIds.includes(session.id)
                              ? 'TIED'
                              : `RANK ${battle.ranking.find((rank) => rank.sessionId === session.id)?.rank ?? '—'}`}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((metric) => (
                    <tr
                      key={metric.key}
                      className={metric.key === 'score' ? 'score-row' : undefined}
                    >
                      <th scope="row">
                        <span>{metric.label}</span>
                        <span className="metric-description">{metric.description}</span>
                      </th>
                      {sessions.map((session) => {
                        const value = metric.value(session)
                        return (
                          <td
                            key={session.id}
                            className={session.id === battle.winnerSessionId ? 'winner-column' : ''}
                          >
                            <button
                              className={`evidence-value ${value === 'PASS' ? 'pass' : value === 'FAIL' ? 'fail' : value === 'N/A' ? 'unavailable' : ''}`}
                              aria-label={`Inspect ${metric.label} for ${names[session.agentId]}`}
                              onClick={() => setEvidence({ session, metric: metric.key })}
                            >
                              {value}
                              {value === 'PASS' && <Icon name="check" size={14} />}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">Session detail</th>
                    {sessions.map((session) => (
                      <td
                        key={session.id}
                        className={session.id === battle.winnerSessionId ? 'winner-column' : ''}
                      >
                        <Link className="text-link" to={`/sessions/${session.id}`}>
                          Replay run
                          <Icon name="arrow" size={16} />
                        </Link>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className={`winner-banner ${winner ? '' : 'neutral'}`}>
            <span className="winner-icon">
              <Icon name="trophy" size={32} />
            </span>
            <div>
              <div className="eyebrow">
                {winner
                  ? 'THIS WORKLOAD’S WINNER'
                  : battle.tiedSessionIds.length
                    ? 'EXACT TIE'
                    : 'RESULT'}
              </div>
              <h2>
                {winner
                  ? names[winner.agentId]
                  : battle.tiedSessionIds.length
                    ? battle.tiedSessionIds
                        .map(
                          (sessionId) =>
                            names[sessions.find((s) => s.id === sessionId)?.agentId ?? 'demo']
                        )
                        .join(' & ')
                    : ['preparing', 'running', 'verifying'].includes(battle.status)
                      ? 'Comparison in progress'
                      : 'No eligible winner'}
              </h2>
              <p>
                {winner
                  ? `Score ${winner.score?.total ?? 'N/A'} · ${winner.score?.requiredPassed ? 'required checks passed' : 'best recorded result; required checks did not pass'}`
                  : 'A winner is calculated only from recorded runs and deterministic ranking.'}
              </p>
            </div>
            {winner && (
              <Link className="button primary" to={`/sessions/${winner.id}`}>
                Inspect winning run
                <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
          <p className="footnote">
            Ranking: required checks pass first, score, failed checks, duration, then patch size.
            Exact ties remain ties. This result describes this task on this repository; it is not a
            universal model ranking. * Estimates are API-equivalent values, not subscription
            charges.
          </p>
          {evidence && (
            <EvidenceDialog
              title={`${names[evidence.session.agentId]} · ${metrics.find((metric) => metric.key === evidence.metric)?.label ?? 'Evidence'}`}
              close={() => setEvidence(null)}
            >
              <BattleEvidence selection={evidence} />
            </EvidenceDialog>
          )}
        </>
      )}
    </>
  )
}
export function BattleEvidence({ selection }: { selection: EvidenceSelection }) {
  const { session, metric } = selection
  const checkFilter: Record<string, (run: VerificationRun) => boolean> = {
    required: (run) => run.required,
    tests: (run) => /test|pytest/i.test(`${run.checkId} ${run.command}`),
    lint: (run) => /lint|ruff|eslint/i.test(`${run.checkId} ${run.command}`),
    build: (run) => /build|typecheck|tsc|compile/i.test(`${run.checkId} ${run.command}`)
  }
  const predicate = checkFilter[metric]
  return (
    <>
      {predicate ? (
        <Verification
          runs={session.verification.filter((run) => run.phase === 'final' && predicate(run))}
        />
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
            <dd>{session.finishedAt ? date(session.finishedAt) : 'Still active'}</dd>
          </div>
          <div>
            <dt>Measured duration</dt>
            <dd>{duration(session.durationMs)}</dd>
          </div>
        </dl>
      ) : metric === 'failures' ? (
        <Findings
          findings={session.findings.filter((f) => /repeat.*fail/i.test(f.type))}
          inspect={() => {
            window.location.href = `/sessions/${session.id}`
          }}
        />
      ) : metric === 'score' ? (
        <>
          <Score value={session.score?.total} />
          <ul className="score-explanations">
            {session.score?.explanation.map((explanation, index) => (
              <li key={index}>{explanation}</li>
            ))}
          </ul>
          <p className="muted">
            Correctness {session.score?.correctness ?? 'N/A'}/50 · code health{' '}
            {session.score?.codeHealth ?? 'N/A'}/15 · change discipline{' '}
            {session.score?.changeDiscipline ?? 'N/A'}/15 · reliability{' '}
            {session.score?.reliability ?? 'N/A'}/10 · efficiency{' '}
            {session.score?.efficiency ?? 'N/A'}/10.
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
            <dt>Total tokens</dt>
            <dd>{number(session.usage.totalTokens)}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>{cost(session.usage.costUsd, session.usage.costType)}</dd>
          </div>
          <div>
            <dt>Cost type</dt>
            <dd>{session.usage.costType?.replaceAll('_', ' ') ?? 'unavailable'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{session.usage.source ?? 'unavailable'}</dd>
          </div>
        </dl>
      )}
      <div className="dialog-footer">
        <Link className="button secondary" to={`/sessions/${session.id}`}>
          Open session evidence
          <Icon name="arrow" size={16} />
        </Link>
      </div>
    </>
  )
}
