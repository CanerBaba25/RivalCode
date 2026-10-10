import { State, Empty, PageHeading, Panel, useApi } from '../lib/common.js'
import type { Page, Session } from '@rivalcode/shared'
import { Filters, Pagination, useFilters } from '../components/Filters.js'
import { SessionTable } from '../components/SessionTable.js'

export function Sessions() {
  const filter = useFilters()
  const query = useApi<Page<Session>>(`/api/sessions?${filter.params}`)
  return (
    <>
      <PageHeading eyebrow="CAPTURE → VERIFY → LEARN" title="Sessions">
        Every run, with the evidence to explain its outcome.
      </PageHeading>
      <Filters state={filter} />
      <State {...query} />
      {query.data && (
        <Panel title="Recorded runs" hint={`${query.data.total} matching sessions`}>
          {query.data.items.length ? (
            <SessionTable
              sessions={query.data.items}
              sortable
              sort={filter.sort}
              onSort={(field) => {
                filter.setSort({
                  field,
                  order:
                    filter.sort.field === field && filter.sort.order === 'desc' ? 'asc' : 'desc'
                })
                filter.setOffset(0)
              }}
            />
          ) : (
            <Empty title="No matching sessions">
              <p>Change your filters or record a session from the CLI.</p>
              <code>rivalcode run codex --task "Your task"</code>
            </Empty>
          )}
          <Pagination page={query.data} offset={filter.offset} onChange={filter.setOffset} />
        </Panel>
      )}
      <p className="footnote">
        N/A means the adapter did not report that metric. * Cost is estimated using configured
        API-equivalent pricing.
      </p>
    </>
  )
}
