import { duration } from '../lib/common.js'
import type { VerificationRun } from '@rivalcode/shared'

export function Verification({
  runs,
  highlighted
}: {
  runs: VerificationRun[]
  highlighted?: string[]
}) {
  return runs.length ? (
    <div className="check-list">
      {runs.map((run) => (
        <article
          key={run.id}
          className={`check ${highlighted?.includes(run.id) || highlighted?.includes(run.checkId) ? 'highlight' : ''}`}
        >
          <div className="check-heading">
            <span className={`check-result ${run.passed ? 'pass' : 'fail'}`}>
              {run.passed ? 'PASS' : run.timedOut ? 'TIMEOUT' : 'FAIL'}
            </span>
            <strong>{run.checkId}</strong>
            <span className="mini-label">
              {run.phase}
              {run.required ? ' · required' : ' · optional'}
            </span>
            <span className="mono">{duration(run.durationMs)}</span>
          </div>
          <code>{run.command}</code>
          {(run.stdout || run.stderr) && (
            <details>
              <summary>Verification output · exit {run.exitCode ?? 'unavailable'}</summary>
              <pre className="output">
                {run.stdout}
                {run.stderr && `\n${run.stderr}`}
              </pre>
            </details>
          )}
        </article>
      ))}
    </div>
  ) : (
    <p className="muted inset">
      No verification checks were configured or recorded. Correctness is unavailable.
    </p>
  )
}
