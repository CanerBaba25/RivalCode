import { useState } from 'react'
import type { Page, Session } from '@rivalcode/shared'
import {
  Agent,
  Empty,
  Icon,
  Link,
  PageHeading,
  Panel,
  Score,
  State,
  Status,
  date,
  duration,
  names,
  shortId,
  useApi
} from '../lib/common.js'
import { Comparison } from '../components/Comparison.js'
import { Filters, Pagination, useFilters } from '../components/Filters.js'

function useSession(id?: string) {
  return useApi<Session>(id ? `/api/sessions/${encodeURIComponent(id)}` : null)
}

function SelectedComparison({ ids }: { ids: string[] }) {
  // Keep four stable hook slots so selecting fewer runs never changes hook order.
  const queries = [useSession(ids[0]), useSession(ids[1]), useSession(ids[2]), useSession(ids[3])]
  const selected = queries.slice(0, ids.length)
  const error = selected.find((query) => query.error)?.error ?? null
  const sessions = selected.flatMap((query) => (query.data ? [query.data] : []))

  return (
    <>
      <PageHeading
        eyebrow="RECORDED RUNS · SIDE BY SIDE"
        title="Compare sessions"
        actions={
          <Link className="button secondary" to="/compare">
            Change selection
          </Link>
        }
      >
        Inspect the trade-offs, choose a reference, and follow every result to its evidence.
      </PageHeading>
      <State
        loading={selected.some((query) => query.loading)}
        error={error}
        retry={() => selected.forEach((query) => query.retry())}
      />
      {!error && sessions.length === ids.length && <Comparison sessions={sessions} />}
    </>
  )
}

function ComparisonPicker() {
  const filter = useFilters()
  const query = useApi<Page<Session>>(`/api/sessions?${filter.params}`)
  const [selection, setSelection] = useState<Session[]>([])
  const full = selection.length === 4

  function toggle(session: Session) {
    setSelection((current) =>
      current.some((item) => item.id === session.id)
        ? current.filter((item) => item.id !== session.id)
        : current.length < 4
          ? [...current, session]
          : current
    )
  }

  return (
    <>
      <PageHeading eyebrow="MAKE THE DIFFERENCES VISIBLE" title="Compare sessions">
        Select two to four recorded runs. Your selection stays with you across filters and pages.
      </PageHeading>
      <div className="selection-toolbar" aria-label="Comparison selection">
        <div>
          <strong>{selection.length} of 4 runs selected</strong>
          <span className="subtext">
            Compare the same task and commit; use Battles for isolated runs.
          </span>
        </div>
        <div className="selection-actions">
          {!!selection.length && (
            <button className="button ghost" onClick={() => setSelection([])}>
              Clear selection
            </button>
          )}
          {selection.length >= 2 ? (
            <Link
              className="button primary"
              to={`/compare/${selection.map((session) => encodeURIComponent(session.id)).join(',')}`}
            >
              Compare {selection.length} runs
              <Icon name="arrow" size={16} />
            </Link>
          ) : (
            <button className="button primary" disabled>
              Select at least 2 runs
            </button>
          )}
        </div>
        {!!selection.length && (
          <div className="selection-chips">
            {selection.map((session) => (
              <button
                key={session.id}
                onClick={() => toggle(session)}
                aria-label={`Remove ${names[session.agentId]} ${session.id} from selection`}
              >
                {names[session.agentId]} <span className="mono">{shortId(session.id)}</span>
                <Icon name="close" size={13} />
              </button>
            ))}
          </div>
        )}
      </div>
      <Filters state={filter} />
      <State {...query} />
      {query.data && (
        <Panel title="Choose your runs" hint={`${query.data.total} matching sessions`}>
          {query.data.items.length ? (
            <div className="table-wrap">
              <table className="selection-table">
                <thead>
                  <tr>
                    <th scope="col">Select</th>
                    <th scope="col">Agent / run</th>
                    <th scope="col">Task / starting point</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Score</th>
                    <th scope="col">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((session) => {
                    const checked = selection.some((item) => item.id === session.id)

                    return (
                      <tr key={session.id} className={checked ? 'selected-run' : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={full && !checked}
                            onChange={() => toggle(session)}
                            aria-label={`Select ${names[session.agentId]} ${session.id}`}
                          />
                        </td>
                        <td>
                          <Agent id={session.agentId} />
                          <span className="subtext mono">{shortId(session.id)}</span>
                          <span className="subtext">{date(session.startedAt)}</span>
                          {session.demo && <span className="mini-label">DEMO RUN</span>}
                        </td>
                        <td>
                          <Link className="table-title" to={`/sessions/${session.id}`}>
                            {session.task ?? 'Task prompt not stored'}
                          </Link>
                          <span className="subtext">
                            {session.repositoryName} ·{' '}
                            <code>{session.baseCommit.slice(0, 10)}</code>
                          </span>
                        </td>
                        <td>
                          <Status status={session.status} />
                        </td>
                        <td>
                          <Score value={session.score?.total} />
                        </td>
                        <td>{duration(session.durationMs)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No runs available for comparison">
              <p>Change your filters or record another agent run.</p>
              <code>rivalcode run codex --task "Your task"</code>
            </Empty>
          )}
          <Pagination page={query.data} offset={filter.offset} onChange={filter.setOffset} />
        </Panel>
      )}
    </>
  )
}

export function Compare({ ids }: { ids?: string }) {
  if (!ids) return <ComparisonPicker />

  const selected = ids.split(',')
  if (
    selected.length < 2 ||
    selected.length > 4 ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !/^[a-zA-Z0-9_-]{1,150}$/.test(id))
  )
    return (
      <Empty title="Choose two to four different runs">
        <p>This comparison link has an invalid selection.</p>
        <Link className="button primary" to="/compare">
          Choose sessions
        </Link>
      </Empty>
    )

  return <SelectedComparison ids={selected} />
}
