import { Icon } from '../lib/common.js'
import type { Finding } from '@rivalcode/shared'

export function Findings({
  findings,
  inspect
}: {
  findings: Finding[]
  inspect: (finding: Finding) => void
}) {
  return findings.length ? (
    <div className="findings">
      {findings.map((finding) => (
        <article key={finding.id} className={`finding ${finding.severity}`}>
          <span className="finding-mark">
            {finding.severity === 'error' ? '!' : finding.severity === 'warning' ? '△' : 'i'}
          </span>
          <div>
            <div className="finding-heading">
              <h3>{finding.title}</h3>
              <span className="mini-label">{finding.severity}</span>
            </div>
            <p>{finding.detail}</p>
            <span className="subtext">{finding.type.replaceAll('_', ' ')}</span>
          </div>
          <button className="button ghost" onClick={() => inspect(finding)}>
            Inspect evidence
            <Icon name="arrow" size={16} />
          </button>
        </article>
      ))}
    </div>
  ) : (
    <div className="clear-state">
      <Icon name="shield" size={36} />
      <h3>No findings recorded</h3>
      <p>Rule-based findings appear when supported by recorded evidence.</p>
    </div>
  )
}
