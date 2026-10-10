import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { AgentId, Session, Battle } from '@rivalcode/shared'

export const names: Record<AgentId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  demo: 'Demo agent'
}
export const Revision = createContext(0)
export const Router = createContext<{ path: string; navigate: (path: string) => void }>({
  path: '/',
  navigate: () => undefined
})
export function Link({
  to,
  children,
  className
}: {
  to: string
  children: React.ReactNode
  className?: string
}) {
  const { navigate } = useContext(Router)
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
          event.preventDefault()
          navigate(to)
        }
      }}
    >
      {children}
    </a>
  )
}
export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Local API returned ${response.status}.`)
  }
  return response.json() as Promise<T>
}
export function useApi<T>(path: string | null): {
  data: T | undefined
  loading: boolean
  error: string | null
  retry: () => void
} {
  const revision = useContext(Revision)
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(Boolean(path))
  const [error, setError] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const previousPath = useRef(path)
  useEffect(() => {
    if (!path) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    if (path !== previousPath.current) {
      setData(undefined)
      previousPath.current = path
    }
    setLoading(true)
    setError(null)
    void request<T>(path, controller.signal)
      .then(setData)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : 'Could not read local data.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [path, revision, retryCount])
  return { data, loading, error, retry: () => setRetryCount((value) => value + 1) }
}
export function duration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return 'N/A'
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
export function number(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'N/A'
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}
export function cost(value: number | null | undefined, type?: string): string {
  return value === null || value === undefined
    ? 'N/A'
    : `$${value.toFixed(3)}${type === 'estimated' || type === 'mixed' ? '*' : ''}`
}
export function date(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
export function shortId(value: string): string {
  return value.slice(0, 8)
}
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    sessions: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    battle: (
      <>
        <path d="m4 3 7 7-3 3-7-7V3ZM20 3l-7 7 3 3 7-7V3ZM4 20l5-5M20 20l-5-5M2 16l6 6M16 22l6-6" />
      </>
    ),
    chart: (
      <>
        <path d="M3 3v18h18M7 16v-5M12 16V7M17 16V4" />
      </>
    ),
    agents: (
      <>
        <rect x="4" y="6" width="16" height="14" rx="3" />
        <path d="M12 3v3M8 11h.01M16 11h.01M8 16h8M1 11v5M23 11v5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    code: (
      <>
        <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    trophy: (
      <>
        <path d="M8 3h8v7a4 4 0 0 1-8 0ZM8 5H4v3a4 4 0 0 0 4 4M16 5h4v3a4 4 0 0 1-4 4M12 14v5M8 21h8M10 19h4" />
      </>
    ),
    folder: <path d="M3 7V5h6l2 3h10v12H3V7Z" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    previous: (
      <>
        <path d="m16 5-10 7 10 7ZM4 5v14" />
      </>
    ),
    next: (
      <>
        <path d="m8 5 10 7-10 7ZM20 5v14" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    )
  }
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] ?? paths.code}
    </svg>
  )
}
export function Agent({ id, compact = false }: { id: AgentId; compact?: boolean }) {
  return (
    <span className="agent">
      <span className={`agent-icon ${id}`}>
        {id === 'codex'
          ? 'Cx'
          : id === 'claude'
            ? 'Cl'
            : id === 'gemini'
              ? 'G'
              : id === 'opencode'
                ? 'Oc'
                : 'D'}
      </span>
      {!compact && <span>{names[id] ?? id}</span>}
    </span>
  )
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status ${status}`}>
      <span className="status-dot" />
      {status.replaceAll('_', ' ')}
    </span>
  )
}
export function Score({ value }: { value: number | null | undefined }) {
  return (
    <span
      className={`score ${value === null || value === undefined ? 'unknown' : value >= 80 ? 'good' : value >= 50 ? 'medium' : 'bad'}`}
    >
      {number(value)}
      {value !== null && value !== undefined && <small>/100</small>}
    </span>
  )
}
export function State({
  loading,
  error,
  retry
}: {
  loading: boolean
  error: string | null
  retry: () => void
}) {
  if (error)
    return (
      <div className="notice error" role="alert">
        <strong>Could not load local records</strong>
        <p>{error}</p>
        <button onClick={retry}>Try again</button>
      </div>
    )
  if (loading)
    return (
      <div className="loading" role="status">
        <span className="spinner" />
        Reading local records…
      </div>
    )
  return null
}
export function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="folder" size={30} />
      </span>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  )
}
export function PageHeading({
  eyebrow,
  title,
  children,
  actions
}: {
  eyebrow: string
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  )
}
export function Panel({
  title,
  hint,
  children,
  action
}: {
  title: string
  hint?: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {hint && <p>{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
export function ExportLinks({ id }: { id: string }) {
  return (
    <div className="export-links">
      <a
        className="button secondary"
        href={`/api/export/${encodeURIComponent(id)}?format=markdown`}
      >
        <Icon name="download" size={16} />
        Report
      </a>
      <a className="button ghost" href={`/api/export/${encodeURIComponent(id)}?format=json`}>
        JSON
      </a>
    </div>
  )
}
export type BattleSummary = Battle & {
  durationMs: number | null
  participants: {
    id: string
    agentId: AgentId
    score: number | null
    durationMs: number
    status: string
    demo: boolean
  }[]
}

export interface OverviewData {
  totalSessions: number
  successfulSessions: number
  failedSessions: number
  activeSessions: number
  averageDurationMs: number | null
  totalTokens: number | null
  totalCostUsd: number | null
  tokensAvailableRuns: number
  costAvailableRuns: number
  costType: string
  agentUsage: { agentId: AgentId; runs: number }[]
  recentSessions: Session[]
  recentFailures: Session[]
  recentBattles: BattleSummary[]
}
export function Metric({
  label,
  value,
  detail,
  icon
}: {
  label: string
  value: React.ReactNode
  detail: React.ReactNode
  icon: string
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <Icon name={icon} />
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
    </div>
  )
}
