import {
  Link,
  Agent,
  Status,
  Score,
  duration,
  number,
  cost,
  costProvenance,
  date
} from '../lib/common.js'
import type { Session } from '@rivalcode/shared'

export function SessionTable({
  sessions,
  sortable,
  sort,
  onSort
}: {
  sessions: Session[]
  sortable?: boolean
  sort?: { field: string; order: string }
  onSort?: (field: string) => void
}) {
  const headings: [string, string][] = [
    ['Task / date', 'startedAt'],
    ...(sortable ? [['Repository', 'repositoryName'] as [string, string]] : []),
    ['Agent', 'agentId'],
    ['Result', 'status'],
    ['Score', 'score'],
    ['Duration', 'durationMs'],
    ['Tokens', 'tokens'],
    ['Cost', 'cost'],
    ['Files', 'files']
  ]
  return (
    <div className="table-wrap">
      <table className={sortable ? 'sessions-table' : undefined}>
        <thead>
          <tr>
            {headings.map(([title, field]) => (
              <th
                key={field}
                aria-sort={
                  sort?.field === field
                    ? sort.order === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
              >
                {sortable ? (
                  <button className="sort-button" onClick={() => field && onSort?.(field)}>
                    {title}
                    {sort?.field === field ? (sort.order === 'asc' ? ' ↑' : ' ↓') : ''}
                  </button>
                ) : (
                  title
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                <Link className="table-title" to={`/sessions/${session.id}`}>
                  {session.task ?? 'Task prompt not stored'}
                </Link>
                <span className="subtext">
                  {!sortable && (
                    <>
                      {session.repositoryName} <span className="sep">/</span>
                    </>
                  )}{' '}
                  {date(session.startedAt)}
                  {session.demo && <span className="mini-label">DEMO</span>}
                </span>
              </td>
              {sortable && (
                <td>
                  <span className="repository-cell" title={session.repositoryPath}>
                    {session.repositoryName}
                  </span>
                </td>
              )}
              <td>
                <Agent id={session.agentId} />
              </td>
              <td>
                <Status status={session.status} />
              </td>
              <td>
                <Score value={session.score?.total} />
              </td>
              <td className="mono">{duration(session.durationMs)}</td>
              <td className="mono">{number(session.usage.totalTokens)}</td>
              <td
                className="mono"
                title={costProvenance(session.usage.costType, session.usage.costUsd)}
              >
                {cost(session.usage.costUsd, session.usage.costType)}
              </td>
              <td className="mono">{session.files.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
