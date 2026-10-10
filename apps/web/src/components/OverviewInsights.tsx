import { Icon, cost, costProvenance, number } from '../lib/common.js'
import type { OverviewData } from '../lib/common.js'

export function overviewRates(
  data: Pick<
    OverviewData,
    'totalSessions' | 'activeSessions' | 'failedSessions' | 'successfulSessions'
  >
) {
  const finished = data.totalSessions - data.activeSessions
  const completed = finished - data.failedSessions

  return {
    finished,
    completed,
    completionRate: data.totalSessions ? (finished / data.totalSessions) * 100 : null,
    successRate: finished ? (data.successfulSessions / finished) * 100 : null
  }
}

export function OutcomePanel({ data }: { data: OverviewData }) {
  const rates = overviewRates(data)

  return (
    <section className="panel outcome-panel" aria-labelledby="outcome-title">
      <div className="focus-heading">
        <div>
          <h2 id="outcome-title">Run outcomes</h2>
          <p>Completion across your recorded sessions.</p>
        </div>
        <Icon name="chart" />
      </div>
      <div className="outcome-summary">
        <strong>
          {rates.completionRate === null ? 'N/A' : `${number(rates.completionRate)}%`}
        </strong>
        <span>
          finished · {rates.finished} of {data.totalSessions} runs
        </span>
      </div>
      {data.totalSessions > 0 && (
        <div
          className="outcome-meter"
          role="meter"
          aria-label="Finished sessions"
          aria-valuemin={0}
          aria-valuemax={data.totalSessions}
          aria-valuenow={rates.finished}
          aria-valuetext={`${rates.finished} of ${data.totalSessions} sessions finished`}
        >
          <span
            className="completed"
            style={{ width: `${(rates.completed / data.totalSessions) * 100}%` }}
          />
          <span
            className="failed"
            style={{ width: `${(data.failedSessions / data.totalSessions) * 100}%` }}
          />
        </div>
      )}
      <dl className="outcome-legend">
        <div>
          <dt>
            <i className="completed" />
            Completed
          </dt>
          <dd>{number(rates.completed)}</dd>
        </div>
        <div>
          <dt>
            <i className="failed" />
            Failed / interrupted
          </dt>
          <dd>{number(data.failedSessions)}</dd>
        </div>
        <div>
          <dt>
            <i className="active" />
            Active
          </dt>
          <dd>{number(data.activeSessions)}</dd>
        </div>
      </dl>
      <p className="footnote">
        Finished runs include failures and interruptions. Active runs are excluded from the success
        rate.
      </p>
    </section>
  )
}

function CoverageRow({
  title,
  available,
  total,
  value,
  detail
}: {
  title: string
  available: number
  total: number
  value: string
  detail: string
}) {
  const percent = total ? (available / total) * 100 : null

  return (
    <div className="coverage-row">
      <div className="coverage-heading">
        <strong>{title}</strong>
        <span>
          {available} / {total} runs
        </span>
      </div>
      {total > 0 && (
        <div
          className="coverage-track"
          role="meter"
          aria-label={`${title} coverage`}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={available}
          aria-valuetext={`${available} of ${total} recorded runs have ${title.toLowerCase()}`}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="coverage-values">
        <span className="mono">{value}</span>
        <span className="subtext">{detail}</span>
      </div>
    </div>
  )
}

export function UsageCoverage({ data }: { data: OverviewData }) {
  return (
    <section className="panel coverage-panel" aria-labelledby="coverage-title">
      <div className="focus-heading">
        <div>
          <h2 id="coverage-title">Usage coverage</h2>
          <p>Recorded measurements, with missing values left unknown.</p>
        </div>
        <Icon name="code" />
      </div>
      <CoverageRow
        title="Token usage"
        available={data.tokensAvailableRuns}
        total={data.totalSessions}
        value={`${number(data.totalTokens)}${data.totalTokens === null ? '' : ' tokens'}`}
        detail={
          data.tokensAvailableRuns
            ? 'Total from runs with recorded usage'
            : 'Token usage unavailable'
        }
      />
      <CoverageRow
        title="Cost"
        available={data.costAvailableRuns}
        total={data.totalSessions}
        value={cost(data.totalCostUsd, data.costType)}
        detail={costProvenance(data.costType, data.totalCostUsd)}
      />
      <p className="footnote">
        Partial coverage does not describe the total usage of unobserved runs. Estimated costs use
        token pricing.
      </p>
    </section>
  )
}
