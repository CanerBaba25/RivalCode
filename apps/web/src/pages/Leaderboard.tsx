import {
  Icon,
  Agent,
  Score,
  State,
  Empty,
  PageHeading,
  Panel,
  useApi,
  duration,
  number,
  cost
} from '../lib/common.js'
import type { LeaderboardRow } from '@rivalcode/shared'
import { Filters, useFilters } from '../components/Filters.js'

export function Leaderboard() {
  const filters = useFilters()
  const query = useApi<LeaderboardRow[]>(`/api/leaderboard?${filters.params}`)
  return (
    <>
      <PageHeading eyebrow="YOUR WORKLOADS, OVER TIME" title="Personal leaderboard">
        Historical results from your recorded sessions. Compare outcomes with context.
      </PageHeading>
      <Filters state={filters} mode="leaderboard" />
      <State {...query} />
      {query.data && (
        <Panel title="Agent performance" hint="Measured from matching recorded sessions">
          {query.data.length ? (
            <div className="table-wrap">
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Runs</th>
                    <th>Success rate</th>
                    <th>Average score</th>
                    <th>Average duration</th>
                    <th>Reported tokens</th>
                    <th>Average cost</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((row, index) => (
                    <tr key={row.agentId}>
                      <td>
                        <span className="leaderboard-agent">
                          <span className="placement">{String(index + 1).padStart(2, '0')}</span>
                          <Agent id={row.agentId} />
                        </span>
                      </td>
                      <td className="mono">{row.runs}</td>
                      <td>
                        <div className="success-cell">
                          <span>{number(row.successRate * 100)}%</span>
                          <div className="tiny-track">
                            <span
                              style={{
                                width: `${row.successRate * 100}%`
                              }}
                            />
                          </div>
                          <span className="subtext">{row.successes} successful</span>
                        </div>
                      </td>
                      <td>
                        <Score value={row.averageScore} />
                      </td>
                      <td className="mono">{duration(row.averageDurationMs)}</td>
                      <td className="mono">{number(row.totalTokens)}</td>
                      <td className="mono">
                        {cost(row.averageCostUsd, row.costType)}
                        <span className="subtext">{row.costType.replaceAll('_', ' ')}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No historical runs match these filters">
              <p>Choose another repository or date range, or record your first session.</p>
            </Empty>
          )}
        </Panel>
      )}
      <div className="context-note">
        <Icon name="shield" size={22} />
        <p>
          This is your personal workload history. It does not establish a universal “best model.”
          Unavailable metrics remain N/A. Estimated costs use token pricing and do not represent
          subscription charges.
        </p>
      </div>
    </>
  )
}
