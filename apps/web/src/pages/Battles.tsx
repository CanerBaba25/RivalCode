import { State, Empty, PageHeading, Panel, useApi } from '../lib/common.js'
import type { Page } from '@rivalcode/shared'
import type { BattleSummary } from '../lib/common.js'
import { Filters, Pagination, useFilters } from '../components/Filters.js'
import { BattleCards } from '../components/BattleCards.js'

export function Battles() {
  const filter = useFilters()
  const query = useApi<Page<BattleSummary>>(`/api/battles?${filter.params}`)
  return (
    <>
      <PageHeading eyebrow="THE COMPARISON ARENA" title="Same task. Real evidence.">
        Each agent starts from the same commit in its own worktree. Verification decides the result.
      </PageHeading>
      <Filters state={filter} mode="battles" />
      <State {...query} />
      {query.data && (
        <Panel title="Recorded battles" hint={`${query.data.total} matching comparisons`}>
          {query.data.items.length ? (
            <BattleCards battles={query.data.items} />
          ) : (
            <Empty title="No battles match this view">
              <p>Compare installed agents from a clean Git repository.</p>
              <code>rivalcode battle --agents codex,claude,gemini --task "Your task"</code>
            </Empty>
          )}
          <Pagination page={query.data} offset={filter.offset} onChange={filter.setOffset} />
        </Panel>
      )}
    </>
  )
}
