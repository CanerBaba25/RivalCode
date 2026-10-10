import { useApi, names } from '../lib/common.js'
import { useState } from 'react'
import type { RepositoryRecord } from '@rivalcode/shared'

export type FilterValues = {
  agent: string
  repository: string
  status: string
  from: string
  to: string
  minScore: string
  maxScore: string
  projectType: string
  tag: string
  demo: string
}
const emptyFilters: FilterValues = {
  agent: '',
  repository: '',
  status: '',
  from: '',
  to: '',
  minScore: '',
  maxScore: '',
  projectType: '',
  tag: '',
  demo: ''
}
export function useFilters() {
  const [values, setValues] = useState<FilterValues>({ ...emptyFilters })
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState({ field: 'startedAt', order: 'desc' })
  const update = (key: keyof FilterValues, value: string) => {
    setValues((previous) => ({ ...previous, [key]: value }))
    setOffset(0)
  }
  const reset = () => {
    setValues({ ...emptyFilters })
    setOffset(0)
  }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
  params.set('limit', '30')
  params.set('offset', String(offset))
  params.set('sort', sort.field)
  params.set('order', sort.order)
  return { values, update, reset, offset, setOffset, sort, setSort, params }
}
export function Filters({
  state,
  mode = 'sessions'
}: {
  state: ReturnType<typeof useFilters>
  mode?: 'sessions' | 'battles' | 'leaderboard'
}) {
  const repositories = useApi<RepositoryRecord[]>('/api/repositories')
  const { values, update, reset } = state
  return (
    <div className="filters" aria-label="Record filters">
      {mode === 'sessions' && (
        <label>
          Agent
          <select
            aria-label="Agent"
            value={values.agent}
            onChange={(event) => update('agent', event.target.value)}
          >
            <option value="">All agents</option>
            {Object.entries(names).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Repository
        <select
          aria-label="Repository"
          value={values.repository}
          onChange={(event) => update('repository', event.target.value)}
        >
          <option value="">All repositories</option>
          {repositories.data?.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.name}
            </option>
          ))}
        </select>
      </label>
      {mode !== 'leaderboard' && (
        <label>
          Status
          <select
            aria-label="Status"
            value={values.status}
            onChange={(event) => update('status', event.target.value)}
          >
            <option value="">All statuses</option>
            {['preparing', 'running', 'verifying', 'completed', 'failed', 'aborted'].map(
              (status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              )
            )}
          </select>
        </label>
      )}
      <label>
        From
        <input
          type="date"
          value={values.from}
          onChange={(event) => update('from', event.target.value)}
        />
      </label>
      <label>
        Until
        <input
          type="date"
          value={values.to}
          onChange={(event) => update('to', event.target.value)}
        />
      </label>
      {mode === 'sessions' && (
        <>
          <label>
            Min score
            <input
              className="score-input"
              type="number"
              min="0"
              max="100"
              placeholder="0"
              value={values.minScore}
              onChange={(event) => update('minScore', event.target.value)}
            />
          </label>
          <label>
            Max score
            <input
              className="score-input"
              type="number"
              min="0"
              max="100"
              placeholder="100"
              value={values.maxScore}
              onChange={(event) => update('maxScore', event.target.value)}
            />
          </label>
        </>
      )}
      {mode === 'leaderboard' && (
        <>
          <label>
            Workload data
            <select
              aria-label="Workload data"
              value={values.demo}
              onChange={(event) => update('demo', event.target.value)}
            >
              <option value="">Recorded agent runs</option>
              <option value="true">Explicit demo fixtures only</option>
            </select>
          </label>
          <label>
            Project type
            <select
              aria-label="Project type"
              value={values.projectType}
              onChange={(event) => update('projectType', event.target.value)}
            >
              <option value="">All project types</option>
              {[...new Set(repositories.data?.map((r) => r.projectType).filter(Boolean))].map(
                (type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                )
              )}
            </select>
          </label>
          <label>
            Task tag
            <input
              maxLength={256}
              placeholder="e.g. refactor"
              value={values.tag}
              onChange={(event) => update('tag', event.target.value)}
            />
          </label>
        </>
      )}
      <button className="button ghost reset-button" onClick={reset}>
        Clear filters
      </button>
      {repositories.error && (
        <span className="filter-error" role="alert">
          {repositories.error} <button onClick={repositories.retry}>Retry repositories</button>
        </span>
      )}
    </div>
  )
}
export function Pagination({
  page,
  offset,
  onChange
}: {
  page: { total: number; limit: number }
  offset: number
  onChange: (offset: number) => void
}) {
  return (
    <div className="pagination">
      <span>
        {page.total
          ? `${offset + 1}–${Math.min(offset + page.limit, page.total)} of ${page.total}`
          : '0 records'}
      </span>
      <div>
        <button
          className="button secondary"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - page.limit))}
        >
          Previous
        </button>
        <button
          className="button secondary"
          disabled={offset + page.limit >= page.total}
          onClick={() => onChange(offset + page.limit)}
        >
          Next
        </button>
      </div>
    </div>
  )
}
