import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join } from 'node:path'
import { Store, createRedactor, loadConfig } from '@rivalcode/runtime'
import { detectAdapters } from '@rivalcode/adapters'
import {
  exportRecord,
  redactBattle,
  redactEvent,
  redactRepository,
  redactSession
} from '@rivalcode/core'
import type {
  Battle,
  NormalizedEvent,
  RivalConfig,
  SessionFilter,
  Session,
  UsageRecord
} from '@rivalcode/shared'

type Redactor = (value: unknown) => unknown
type CapturePrivacy = { config: RivalConfig; redact: Redactor }
type PrivacyEnv = { Variables: { privacy: CapturePrivacy } }

const safeSession = (session: Session, privacy: CapturePrivacy) =>
  redactSession(session, privacy.redact, privacy.config)
const safeBattle = (battle: Battle, privacy: CapturePrivacy) =>
  redactBattle(battle, privacy.redact, privacy.config)

const agents = new Set(['codex', 'claude', 'gemini', 'opencode', 'demo'])
const statuses = new Set(['preparing', 'running', 'verifying', 'completed', 'failed', 'aborted'])
const sortKeys = new Set([
  'startedAt',
  'durationMs',
  'score',
  'tokens',
  'cost',
  'files',
  'agentId',
  'repositoryName',
  'status'
])
const filterKeys = new Set([
  'agent',
  'repository',
  'status',
  'from',
  'to',
  'minScore',
  'maxScore',
  'tag',
  'projectType',
  'incomplete',
  'demo',
  'limit',
  'offset',
  'sort',
  'order'
])

class InputError extends Error {}
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new InputError('Pagination requires whole numbers.')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new InputError(`Value must be between ${min} and ${max}.`)
  return parsed
}
function filters(query: Record<string, string>): SessionFilter {
  const filter: SessionFilter = {}
  for (const [key, value] of Object.entries(query)) {
    if (!filterKeys.has(key)) throw new InputError(`Unknown filter: ${key}`)
    if (value.length > 256) throw new InputError('Filter values must be 256 characters or fewer.')
    if (['agent', 'repository', 'status', 'tag', 'projectType'].includes(key)) {
      if (key === 'agent' && !agents.has(value)) throw new InputError('Unknown agent.')
      if (key === 'status' && !statuses.has(value)) throw new InputError('Unknown status.')
      Object.assign(filter, { [key]: value })
    } else if (key === 'from' || key === 'to') {
      if (
        !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(
          value
        ) ||
        !Number.isFinite(Date.parse(value))
      )
        throw new InputError('Date filters must use ISO dates or timestamps with a timezone.')
      const day = value.slice(0, 10)
      if (new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day)
        throw new InputError('Date filters must contain a valid calendar date.')
      Object.assign(filter, {
        [key]:
          value.length === 10
            ? `${value}T${key === 'to' ? '23:59:59.999' : '00:00:00.000'}Z`
            : new Date(value).toISOString()
      })
    } else if (key === 'minScore' || key === 'maxScore') {
      const score = Number(value)
      if (value === '' || !Number.isFinite(score) || score < 0 || score > 100)
        throw new InputError('Score filters must be between 0 and 100.')
      Object.assign(filter, { [key]: score })
    } else if (key === 'incomplete' || key === 'demo') {
      if (!['true', 'false'].includes(value)) throw new InputError(`${key} must be true or false.`)
      Object.assign(filter, { [key]: value === 'true' })
    } else if (key === 'sort') {
      if (!sortKeys.has(value)) throw new InputError('Unknown sort field.')
      filter.sort = value
    } else if (key === 'order') {
      if (value !== 'asc' && value !== 'desc')
        throw new InputError('Sort order must be asc or desc.')
      filter.order = value
    }
  }
  filter.limit = integer(query.limit, 30, 1, 200)
  filter.offset = integer(query.offset, 0, 0, 1_000_000)
  if (filter.from && filter.to && filter.from > filter.to)
    throw new InputError('Start date must precede end date.')
  if (
    filter.minScore !== undefined &&
    filter.maxScore !== undefined &&
    filter.minScore > filter.maxScore
  )
    throw new InputError('Minimum score must not exceed maximum score.')
  return filter
}
function localHost(host: string | undefined): boolean {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}
function recordId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new InputError('Invalid record ID.')
  return id
}
function inside(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel !== '' && !rel.startsWith(`..`) && !isAbsolute(rel)
}
async function readDiff(store: Store, session: Session): Promise<string> {
  const stateRoot = await realpath(store.stateDir)
  const directory = session.artifactDir.includes('[REDACTED]')
    ? join(stateRoot, 'sessions', recordId(session.id))
    : resolve(session.artifactDir)
  if (!inside(stateRoot, directory))
    throw new InputError('Artifact path is outside this repository state directory.')
  const resolvedDirectory = await realpath(directory).catch(() => null)
  if (!resolvedDirectory) return ''
  if (!inside(stateRoot, resolvedDirectory))
    throw new InputError('Artifact directory is outside this repository state directory.')
  const file = await realpath(join(resolvedDirectory, 'final.diff')).catch(() => null)
  if (!file) return ''
  if (!inside(resolvedDirectory, file)) throw new InputError('Artifact path is not a session diff.')
  const metadata = await stat(file)
  if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024)
    throw new InputError('Diff exceeds the dashboard display limit; use the local artifact.')
  return readFile(file, 'utf8')
}
function totals(sessions: Session[], key: keyof UsageRecord): number | null {
  const values = sessions
    .map((s) => s.usage[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
}
async function revision(store: Store): Promise<string> {
  const files = await Promise.all(
    [store.dbPath, `${store.dbPath}-wal`].map(async (path) => {
      const metadata = await stat(path).catch(() => null)
      return metadata ? `${metadata.mtimeMs}:${metadata.size}` : 'absent'
    })
  )
  return files.join('|')
}

/** Read-only localhost API. The CLI owns writes; SSE observes persisted changes across processes. */
export function createApp(root: string, webDir?: string): Hono<PrivacyEnv> {
  const store = new Store(resolve(root))
  const app = new Hono<PrivacyEnv>()
  const battleSummary = (battle: Battle, privacy: CapturePrivacy) => ({
    ...safeBattle(battle, privacy),
    durationMs: battle.finishedAt
      ? Math.max(0, Date.parse(battle.finishedAt) - Date.parse(battle.startedAt))
      : null,
    participants: battle.sessionIds.flatMap((id) => {
      const session = store.getSession(id)
      return session
        ? [
            {
              id: session.id,
              agentId: session.agentId,
              score: session.score?.total ?? null,
              durationMs: session.durationMs,
              status: session.status,
              demo: session.demo
            }
          ]
        : []
    })
  })
  app.use('*', async (context, next) => {
    const host = context.req.header('host')
    const origin = context.req.header('origin')
    if (!localHost(host))
      return context.json({ error: 'This server accepts localhost requests only.' }, 403)
    if (origin) {
      try {
        const parsed = new URL(origin)
        const target = new URL(`http://${host}`)
        if (
          parsed.protocol !== 'http:' ||
          parsed.origin !== origin ||
          !localHost(parsed.host) ||
          parsed.port !== target.port
        )
          return context.json({ error: 'Cross-origin requests are not allowed.' }, 403)
      } catch {
        return context.json({ error: 'Invalid request origin.' }, 403)
      }
    }
    if (context.req.url.length > 8192)
      return context.json({ error: 'Request URL is too long.' }, 414)
    context.header('X-Content-Type-Options', 'nosniff')
    context.header('Referrer-Policy', 'no-referrer')
    context.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    if (context.req.path.startsWith('/api/')) context.header('Cache-Control', 'no-store')
    await next()
  })
  app.onError((error, context) => {
    if (error instanceof InputError) return context.json({ error: error.message }, 400)
    console.error('[RivalCode API]', error.message)
    return context.json(
      { error: 'Unable to read local records. See the local server log for details.' },
      500
    )
  })
  app.use('/api/*', async (context, next) => {
    // Re-read privacy settings and dotenv literals to protect archived records when
    // local credentials change while the dashboard is open.
    const config = await loadConfig(root)
    const redact = await createRedactor(root, config)
    context.set('privacy', { config, redact })
    await next()
  })
  app.get('/api/health', (context) => context.json({ ok: true, version: '0.1.0', local: true }))
  let detection: ReturnType<typeof detectAdapters> | undefined
  let detectedAt = 0
  app.get('/api/agents', async (context) => {
    if (!detection || Date.now() - detectedAt > 30_000) {
      detection = detectAdapters()
      detectedAt = Date.now()
    }
    return context.json(await detection)
  })
  app.get('/api/repositories', (context) =>
    context.json(
      store
        .repositories()
        .map((repository) => redactRepository(repository, context.get('privacy').redact))
    )
  )
  app.get('/api/sessions', (context) => {
    const page = store.listSessions(filters(context.req.query()))
    return context.json({
      ...page,
      items: page.items.map((session) => safeSession(session, context.get('privacy')))
    })
  })
  app.get('/api/sessions/:id', (context) => {
    const session = store.getSession(recordId(context.req.param('id')))
    return session
      ? context.json(safeSession(session, context.get('privacy')))
      : context.json({ error: 'Session not found.' }, 404)
  })
  app.get('/api/sessions/:id/events', (context) => {
    const id = recordId(context.req.param('id'))
    if (!store.getSession(id)) return context.json({ error: 'Session not found.' }, 404)
    const query = context.req.query()
    for (const key of Object.keys(query))
      if (!['limit', 'offset'].includes(key)) throw new InputError(`Unknown event filter: ${key}`)
    const limit = integer(query.limit, 100, 1, 500)
    const offset = integer(query.offset, 0, 0, 1_000_000)
    const { config, redact } = context.get('privacy')
    const items: NormalizedEvent[] = []
    let total = 0
    for (let rawOffset = 0; ; rawOffset += 500) {
      const page = store.getEvents(id, 500, rawOffset)
      for (const event of page.items) {
        const safe = redactEvent(event, config, redact)
        if (!safe) continue
        if (total >= offset && items.length < limit) items.push(safe)
        total++
      }
      if (rawOffset + page.items.length >= page.total || !page.items.length) break
    }
    return context.json({ items, total, limit, offset })
  })
  app.get('/api/sessions/:id/diff', async (context) => {
    const session = store.getSession(recordId(context.req.param('id')))
    if (!session) return context.json({ error: 'Session not found.' }, 404)
    return context.json({
      diff: String(context.get('privacy').redact(await readDiff(store, session))),
      fidelity: 'final',
      files: safeSession(session, context.get('privacy')).files
    })
  })
  app.get('/api/sessions/:id/findings', (context) => {
    const session = store.getSession(recordId(context.req.param('id')))
    return session
      ? context.json(safeSession(session, context.get('privacy')).findings)
      : context.json({ error: 'Session not found.' }, 404)
  })
  app.get('/api/battles', (context) => {
    const page = store.listBattles(filters(context.req.query()))
    return context.json({
      ...page,
      items: page.items.map((battle) => battleSummary(battle, context.get('privacy')))
    })
  })
  app.get('/api/battles/:id', (context) => {
    const battle = store.getBattle(recordId(context.req.param('id')))
    return battle
      ? context.json({
          ...safeBattle(battle, context.get('privacy')),
          sessions: battle.sessionIds.flatMap((id) => {
            const session = store.getSession(id)
            return session ? [safeSession(session, context.get('privacy'))] : []
          })
        })
      : context.json({ error: 'Battle not found.' }, 404)
  })
  app.get('/api/leaderboard', (context) =>
    context.json(store.leaderboard(filters(context.req.query())))
  )
  app.get('/api/overview', (context) => {
    const filter = filters(context.req.query())
    const sessions: Session[] = []
    let offset = 0
    for (;;) {
      const page = store.listSessions({ ...filter, limit: 200, offset })
      sessions.push(...page.items)
      offset += page.items.length
      if (offset >= page.total || page.items.length === 0) break
    }
    const usageByAgent = [...new Set(sessions.map((session) => session.agentId))].map(
      (agentId) => ({
        agentId,
        runs: sessions.filter((session) => session.agentId === agentId).length
      })
    )
    const costs = sessions.filter((session) => Number.isFinite(session.usage.costUsd))
    const costTypes = new Set(costs.map((session) => session.usage.costType ?? 'unknown'))
    return context.json({
      totalSessions: sessions.length,
      successfulSessions: sessions.filter(
        (s) => s.status === 'completed' && (s.score?.requiredPassed ?? true)
      ).length,
      failedSessions: sessions.filter((s) => s.status === 'failed' || s.status === 'aborted')
        .length,
      activeSessions: sessions.filter((s) =>
        ['preparing', 'running', 'verifying'].includes(s.status)
      ).length,
      averageDurationMs: sessions.length
        ? sessions.reduce((sum, s) => sum + s.durationMs, 0) / sessions.length
        : null,
      totalTokens: totals(sessions, 'totalTokens'),
      totalCostUsd: totals(sessions, 'costUsd'),
      tokensAvailableRuns: sessions.filter((s) => s.usage.totalTokens !== undefined).length,
      costAvailableRuns: costs.length,
      costType: costTypes.size > 1 ? 'mixed' : ([...costTypes][0] ?? 'unknown'),
      agentUsage: usageByAgent,
      recentSessions: sessions
        .slice(0, 6)
        .map((session) => safeSession(session, context.get('privacy'))),
      recentFailures: sessions
        .filter((s) => s.status === 'failed' || s.status === 'aborted')
        .slice(0, 5)
        .map((session) => safeSession(session, context.get('privacy'))),
      recentBattles: store
        .listBattles({ ...filter, limit: 4, offset: 0 })
        .items.map((battle) => battleSummary(battle, context.get('privacy')))
    })
  })
  app.get('/api/export/:id', async (context) => {
    const id = recordId(context.req.param('id'))
    const format = context.req.query('format') ?? 'json'
    if (format !== 'json' && format !== 'markdown')
      throw new InputError('Export format must be json or markdown.')
    if (!store.getSession(id) && !store.getBattle(id))
      return context.json({ error: 'Record not found.' }, 404)
    const content = await exportRecord(root, id, format)
    context.header(
      'Content-Disposition',
      `attachment; filename="rivalcode-${id}.${format === 'json' ? 'json' : 'md'}"`
    )
    return context.body(
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      200,
      { 'Content-Type': format === 'json' ? 'application/json' : 'text/markdown; charset=utf-8' }
    )
  })
  app.get('/api/stream', (context) =>
    streamSSE(context, async (stream) => {
      let running = true
      let previous = await revision(store)
      stream.onAbort(() => {
        running = false
      })
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ revision: previous }) })
      let ticks = 0
      while (running) {
        await stream.sleep(1000)
        if (!running) break
        const current = await revision(store)
        if (current !== previous) {
          previous = current
          await stream.writeSSE({ event: 'update', data: JSON.stringify({ revision: current }) })
        }
        if (++ticks % 15 === 0) await stream.writeSSE({ event: 'heartbeat', data: '{}' })
      }
    })
  )
  app.get('/api/*', (context) => context.json({ error: 'API endpoint not found.' }, 404))
  if (webDir) {
    const webRoot = resolve(webDir)
    app.use('/assets/*', serveStatic({ root: webRoot }))
    app.get('*', async (context) => {
      if (context.req.path.includes('.') && context.req.path !== '/')
        return context.text('Not found.', 404)
      const html = await readFile(join(webRoot, 'index.html'), 'utf8').catch(() => null)
      return html
        ? context.html(html)
        : context.text(
            'Dashboard assets are missing. Run pnpm build from the RivalCode source checkout.',
            503
          )
    })
  } else
    app.get('*', (context) =>
      context.text('RivalCode API is running. Build the dashboard with pnpm build.', 200)
    )
  // Store disposal is attached for the server lifecycle and integration tests.
  let disposed = false
  Object.assign(app, {
    dispose: () => {
      if (disposed) return
      disposed = true
      store.close()
    }
  })
  return app
}

export async function startServer(
  root: string,
  options: { port?: number; webDir?: string } = {}
): Promise<{ url: string; close: () => Promise<void> }> {
  const port = options.port ?? 4317
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new InputError('Port must be an integer between 0 and 65535.')
  const app = createApp(root, options.webDir)
  const disposable = app as typeof app & { dispose: () => void }
  const server = await new Promise<ReturnType<typeof serve>>((resolveServer, reject) => {
    const instance = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () =>
      resolveServer(instance)
    )
    instance.once('error', reject)
  }).catch((error: unknown) => {
    disposable.dispose()
    throw error
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Unable to resolve local server address.')
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      closing ??= new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          disposable.dispose()
          if (error) reject(error)
          else resolveClose()
        })
        if ('closeAllConnections' in server) server.closeAllConnections()
      })
      return closing
    }
  }
}
