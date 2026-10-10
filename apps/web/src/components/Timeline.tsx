import { Icon, State, Empty, request, duration, Revision } from '../lib/common.js'
import { useContext, useState, useEffect, useMemo } from 'react'
import type { Session, NormalizedEvent, Page } from '@rivalcode/shared'

function eventOutcome(event: NormalizedEvent): 'failed' | 'passed' | '' {
  const payload = event.payload
  if (
    event.type === 'error' ||
    payload.failed === true ||
    payload.success === false ||
    payload.passed === false ||
    (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
  )
    return 'failed'
  if (payload.success === true || payload.passed === true || payload.exitCode === 0) return 'passed'
  return ''
}

export function eventLabel(event: NormalizedEvent): string {
  const payload = event.payload
  const command =
    typeof payload.command === 'string'
      ? payload.command
      : typeof payload.toolName === 'string'
        ? payload.toolName
        : typeof payload.name === 'string'
          ? payload.name
          : typeof payload.tool === 'string'
            ? payload.tool
            : typeof payload.checkId === 'string'
              ? payload.checkId
              : ''
  const path = eventPath(event)
  const outcome = eventOutcome(event)
  const result = outcome ? ` · ${outcome}` : ''
  const labels: Record<string, string> = {
    session_started: 'Session started',
    session_finished: 'Session finished',
    task: 'Task submitted',
    assistant_output: 'Assistant output',
    tool_started: `Tool started${command ? ` · ${command}` : ''}`,
    tool_finished: `Tool finished${command ? ` · ${command}` : ''}${result}`,
    command_started: `Command started${command ? ` · ${command}` : ''}`,
    command_finished: `Command finished${command ? ` · ${command}` : ''}${result}`,
    file_changed: `File changed${path ? ` · ${path}` : ''}`,
    permission_requested: 'Permission requested',
    permission_resolved: 'Permission resolved',
    usage: 'Usage reported',
    cost: 'Cost reported',
    error: 'Error observed',
    verification_started: `Verification started${command ? ` · ${command}` : ''}`,
    verification_finished: `Verification finished${command ? ` · ${command}` : ''}${result}`,
    finding: 'Finding recorded'
  }
  return labels[event.type] ?? event.type
}
export function eventPath(event: NormalizedEvent): string | null {
  return typeof event.payload.path === 'string'
    ? event.payload.path
    : typeof event.payload.file === 'string'
      ? event.payload.file
      : null
}
export function Payload({ payload }: { payload: Record<string, unknown> }) {
  const outputKeys = new Set(['text', 'delta', 'output', 'stdout', 'stderr'])
  const outputs = Object.entries(payload).filter(
    ([key, value]) => outputKeys.has(key) && typeof value === 'string'
  )
  const metadata = Object.fromEntries(
    Object.entries(payload).filter(
      ([key, value]) => !outputKeys.has(key) || typeof value !== 'string'
    )
  )

  return (
    <>
      {Object.keys(metadata).length > 0 && (
        <pre className="output event-output">{JSON.stringify(metadata, null, 2)}</pre>
      )}
      {outputs.map(([key, value]) => (
        <div key={key}>
          <span className="subtext">{key}</span>
          <pre className="output event-output">{String(value)}</pre>
        </div>
      ))}
    </>
  )
}
export function Timeline({
  session,
  focusIds,
  onFile
}: {
  session: Session
  focusIds?: string[]
  onFile: (path: string) => void
}) {
  const revision = useContext(Revision)
  const [events, setEvents] = useState<NormalizedEvent[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [type, setType] = useState('all')
  const [source, setSource] = useState('all')
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [limit, setLimit] = useState(500)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    async function load() {
      const result: NormalizedEvent[] = []
      let expected = 0
      for (let offset = 0; offset < limit; offset += 500) {
        const page = await request<Page<NormalizedEvent>>(
          `/api/sessions/${session.id}/events?limit=500&offset=${offset}`,
          controller.signal
        )
        result.push(...page.items)
        expected = page.total
        if (result.length >= page.total || page.items.length === 0) break
      }
      setEvents(result)
      setTotal(expected)
    }
    void load()
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : 'Could not load timeline.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [session.id, revision, limit, retry])
  const filtered = useMemo(
    () =>
      events.filter(
        (event) =>
          (type === 'all' || event.type === type) && (source === 'all' || event.source === source)
      ),
    [events, type, source]
  )
  useEffect(() => {
    if (focusIds?.length) {
      setType('all')
      setSource('all')
      const index = events.findIndex((event) => focusIds.includes(event.id))
      if (index >= 0) setCursor(index)
      else if (!loading && events.length < total) setLimit((value) => value + 500)
    }
  }, [focusIds, events, loading, total])
  useEffect(() => {
    setCursor((previous) => Math.min(previous, Math.max(0, filtered.length - 1)))
  }, [filtered.length])
  useEffect(() => {
    if (!playing || cursor >= filtered.length - 1) {
      if (playing) setPlaying(false)
      return
    }
    const current = filtered[cursor]
    const next = filtered[cursor + 1]
    const difference =
      next && current ? Date.parse(next.timestamp) - Date.parse(current.timestamp) : 1000
    const timeout = setTimeout(
      () => setCursor((value) => value + 1),
      Math.min(5000, Math.max(150, difference / speed))
    )
    return () => clearTimeout(timeout)
  }, [playing, cursor, speed, filtered])
  const selected = filtered[cursor]
  const move = (delta: number) => {
    setPlaying(false)
    setCursor((value) => Math.max(0, Math.min(filtered.length - 1, value + delta)))
  }
  return (
    <div className="timeline">
      <div className="replay-toolbar">
        <div className="playback-buttons">
          <button
            aria-label="Previous event"
            disabled={!filtered.length || cursor === 0}
            onClick={() => move(-1)}
          >
            <Icon name="previous" />
          </button>
          <button
            className="play-button"
            aria-label={playing ? 'Pause replay' : 'Play replay'}
            disabled={!filtered.length}
            onClick={() => {
              if (!playing && cursor === filtered.length - 1) setCursor(0)
              setPlaying((value) => !value)
            }}
          >
            <Icon name={playing ? 'pause' : 'play'} />
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            aria-label="Next event"
            disabled={!filtered.length || cursor >= filtered.length - 1}
            onClick={() => move(1)}
          >
            <Icon name="next" />
          </button>
        </div>
        <label>
          Speed
          <select
            aria-label="Speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            {[0.5, 1, 2, 4, 8].map((value) => (
              <option value={value} key={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <label>
          Events
          <select
            aria-label="Events"
            value={type}
            onChange={(event) => {
              setType(event.target.value)
              setCursor(0)
              setPlaying(false)
            }}
          >
            <option value="all">All event types</option>
            {[...new Set(events.map((event) => event.type))].map((value) => (
              <option value={value} key={value}>
                {value.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select
            aria-label="Source"
            value={source}
            onChange={(event) => {
              setSource(event.target.value)
              setCursor(0)
              setPlaying(false)
            }}
          >
            <option value="all">All sources</option>
            {[...new Set(events.map((event) => event.source))].map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <span className="replay-position mono">
          {filtered.length ? cursor + 1 : 0} / {filtered.length}
        </span>
      </div>
      <p className="fidelity-note">
        Replay uses recorded timestamps; long gaps are capped at five seconds for navigation.
        Native/tool events are labeled by source. Git observations show the saved final diff.
      </p>
      <State
        loading={loading && !events.length}
        error={error}
        retry={() => setRetry((value) => value + 1)}
      />
      {filtered.length ? (
        <div className="timeline-grid">
          <div className="event-list" aria-label="Timeline events">
            {filtered.map((event, index) => (
              <button
                key={event.id}
                className={`event-row ${index === cursor ? 'selected' : ''} ${focusIds?.includes(event.id) ? 'highlight' : ''}`}
                aria-pressed={index === cursor}
                onClick={() => {
                  setPlaying(false)
                  setCursor(index)
                }}
              >
                <span className="event-time mono">
                  {duration(
                    Math.max(0, Date.parse(event.timestamp) - Date.parse(session.startedAt))
                  )}
                </span>
                <span
                  className={`event-marker ${eventOutcome(event) === 'failed' ? 'error' : ''}`}
                />
                <span className="event-text">
                  <strong>{eventLabel(event)}</strong>
                  <span className="subtext">
                    {event.source} · {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="event-detail">
            {selected && (
              <>
                <div className="eyebrow">RECORDED EVENT · {selected.source.toUpperCase()}</div>
                <h3>{eventLabel(selected)}</h3>
                <span className="subtext mono">{selected.id}</span>
                <Payload payload={selected.payload} />
                {eventPath(selected) && (
                  <button
                    className="button secondary"
                    onClick={() => {
                      const observed = (eventPath(selected) ?? '').replaceAll('\\', '/')
                      const matching = session.files.find(
                        (file) => observed === file.path || observed.endsWith(`/${file.path}`)
                      )
                      onFile(matching?.path ?? observed.replace(/^\.\//, ''))
                    }}
                  >
                    Inspect saved final diff
                    <Icon name="arrow" size={16} />
                  </button>
                )}
                <p className="footnote">
                  {selected.source === 'native'
                    ? 'Reported by the agent’s native event stream.'
                    : selected.source === 'git'
                      ? 'Observed from Git. This event does not imply an individual edit snapshot.'
                      : `Observed through ${selected.source}. No hidden reasoning is captured.`}
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        !loading && (
          <Empty title="No events match this view">
            <p>
              {events.length
                ? 'Choose another event type or source.'
                : 'This session has no recorded events yet.'}
            </p>
          </Empty>
        )
      )}
      {events.length < total && (
        <div className="pagination">
          <span>
            {events.length} of {total} events loaded
          </span>
          <button
            className="button secondary"
            disabled={loading}
            onClick={() => setLimit((value) => value + 500)}
          >
            Load next 500 events
          </button>
        </div>
      )}
    </div>
  )
}
