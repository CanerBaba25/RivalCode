import { useEffect, useState } from 'react'
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

const selectionKey = 'rivalcode.comparison-selection'
const validId = /^[a-zA-Z0-9_-]{1,150}$/

function savedSelection(): string[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(selectionKey) ?? '[]')
    if (!Array.isArray(saved)) return []

    return [
      ...new Set(saved.filter((id): id is string => typeof id === 'string' && validId.test(id)))
    ].slice(0, 4)
  } catch {
    return []
  }
}

function rememberSelection(ids: string[]) {
  try {
    // Store identifiers only; prompts and session records stay in the local API.
    sessionStorage.setItem(selectionKey, JSON.stringify(ids))
  } catch {
    // Browsers that restrict storage can still compare runs in the current view.
  }
}

function useSession(id?: string) {
  return useApi<Session>(id ? `/api/sessions/${encodeURIComponent(id)}` : null)
}

function SelectedComparison({ ids }: { ids: string[] }) {
  // Keep four stable hook slots so selecting fewer runs never changes hook order.
  const queries = [useSession(ids[0]), useSession(ids[1]), useSession(ids[2]), useSession(ids[3])]
  const selected = queries.slice(0, ids.length)
  const error = selected.find((query) => query.error)?.error ?? null
  const sessions = selected.flatMap((query) => (query.data ? [query.data] : []))
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const selection = ids.join(',')

  useEffect(() => rememberSelection(selection.split(',')), [selection])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setShareState('copied')
    } catch {
      setShareState('manual')
    }
  }

  return (
    <>
      <PageHeading
        eyebrow="RECORDED RUNS · SIDE BY SIDE"
        title="Compare sessions"
        actions={
          <>
            <button className="button secondary" onClick={() => void copyLink()}>
              Copy comparison link
            </button>
            <Link className="button secondary" to="/compare">
              Change selection
            </Link>
          </>
        }
      >
        Inspect the trade-offs, choose a reference, and follow every result to its evidence.
      </PageHeading>
      {shareState !== 'idle' && (
        <div className="comparison-share" role="status">
          <span>
            {shareState === 'copied'
              ? 'Comparison link copied.'
              : 'Copy the comparison link below.'}{' '}
            This link opens history on this machine.
          </span>
          {shareState === 'manual' && (
            <input
              aria-label="Comparison link"
              readOnly
              value={window.location.href}
              onFocus={(event) => event.target.select()}
            />
          )}
        </div>
      )}
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
  const [selection, setSelection] = useState<string[]>(savedSelection)
  const selectedQueries = [
    useSession(selection[0]),
    useSession(selection[1]),
    useSession(selection[2]),
    useSession(selection[3])
  ].slice(0, selection.length)
  const unavailable = selectedQueries.some((selected) => selected.error)
  const full = selection.length === 4

  useEffect(() => rememberSelection(selection), [selection])

  function toggle(id: string) {
    setSelection((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length < 4
          ? [...current, id]
          : current
    )
  }

  return (
    <>
      <PageHeading eyebrow="MAKE THE DIFFERENCES VISIBLE" title="Compare sessions">
        Select two to four recorded runs. Your selection stays across filters and pages; tab storage
        retains it through reloads and Change selection when available.
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
          {selection.length >= 2 && !unavailable ? (
            <Link className="button primary" to={`/compare/${selection.join(',')}`}>
              Compare {selection.length} runs
              <Icon name="arrow" size={16} />
            </Link>
          ) : (
            <button className="button primary" disabled>
              {unavailable ? 'Remove unavailable runs' : 'Select at least 2 runs'}
            </button>
          )}
        </div>
        {!!selection.length && (
          <div className="selection-chips">
            {selection.map((id, index) => {
              const selected = selectedQueries[index]
              const agent = selected?.data ? names[selected.data.agentId] : 'Run'

              return (
                <button
                  key={id}
                  onClick={() => toggle(id)}
                  aria-label={`Remove ${agent} ${id} from selection`}
                >
                  {agent} <span className="mono">{shortId(id)}</span>
                  {selected?.error && <span>Unavailable</span>}
                  <Icon name="close" size={13} />
                </button>
              )
            })}
          </div>
        )}
      </div>
      {unavailable && (
        <div className="comparison-share" role="alert">
          <span>A selected run could not be loaded. Remove it or retry before comparing.</span>
          <button
            className="button secondary"
            onClick={() => selectedQueries.forEach((selected) => selected.retry())}
          >
            Retry selected runs
          </button>
        </div>
      )}
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
                    const checked = selection.includes(session.id)

                    return (
                      <tr key={session.id} className={checked ? 'selected-run' : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={full && !checked}
                            onChange={() => toggle(session.id)}
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
    selected.some((id) => !validId.test(id))
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
