import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join } from 'node:path'
import {
  Store,
  createRedactor,
  defaultConfig,
  loadConfig,
  normalizeDateBound
} from '@rivalcode/runtime'
import { detectAdapters } from '@rivalcode/adapters'
import { RIVALCODE_VERSION } from '@rivalcode/shared'
import {
  exportRecord,
  redactBattle,
  redactEvent,
  redactRepository,
  redactSession
} from '@rivalcode/core'
import type {
  AgentDetection,
  Battle,
  NormalizedEvent,
  RivalConfig,
  SessionFilter,
  Session
} from '@rivalcode/shared'

type Redactor = (value: unknown) => unknown
type CapturePrivacy = { config: RivalConfig; redact: Redactor }
type PrivacyEnv = { Variables: { privacy: CapturePrivacy } }

const safeSession = (session: Session, privacy: CapturePrivacy) =>
  redactSession(session, privacy.redact, privacy.config)
const safeBattle = (battle: Battle, privacy: CapturePrivacy) =>
  redactBattle(battle, privacy.redact, privacy.config)
const safeDetection = (agent: AgentDetection, redact: Redactor): AgentDetection => ({
  ...agent,
  displayName: String(redact(agent.displayName)),
  version: agent.version === null ? null : String(redact(agent.version)),
  detail: agent.detail === undefined ? undefined : String(redact(agent.detail))
})

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
      try {
        Object.assign(filter, { [key]: normalizeDateBound(value, key === 'to') })
      } catch (error) {
        throw new InputError(error instanceof Error ? error.message : String(error))
      }
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
  const repositoryRoot = await realpath(resolve(store.stateDir, '..'))
  const stateRoot = await realpath(store.stateDir)
  if (!inside(repositoryRoot, stateRoot))
    throw new InputError('State directory is outside this repository.')

  const directory = session.artifactDir.includes('[REDACTED]')
    ? join(stateRoot, 'sessions', recordId(session.id))
    : resolve(session.artifactDir)
  if (!inside(stateRoot, directory))
    throw new InputError('Artifact path is outside this repository state directory.')
  const resolvedDirectory = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!resolvedDirectory) return ''
  if (!inside(stateRoot, resolvedDirectory))
    throw new InputError('Artifact directory is outside this repository state directory.')
  const file = join(resolvedDirectory, 'final.diff')
  const metadata = await lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!metadata) return ''
  if (!metadata.isFile() || metadata.nlink !== 1n)
    throw new InputError('Saved diff must be a regular file without links.')
  if (metadata.size > 32n * 1024n * 1024n)
    throw new InputError('Diff exceeds the dashboard display limit; use the local artifact.')

  const descriptor = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )

  try {
    const opened = await descriptor.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    )
      throw new InputError('Saved diff changed before it could be opened. Retry the request.')

    const size = Number(metadata.size)
    const bytes = Buffer.alloc(size + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await descriptor.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }

    const after = await descriptor.stat({ bigint: true })
    if (
      length !== size ||
      after.size !== metadata.size ||
      after.mtimeNs !== metadata.mtimeNs ||
      after.nlink !== 1n
    )
      throw new InputError('Saved diff changed while reading. Retry the request.')

    return bytes.subarray(0, length).toString('utf8')
  } finally {
    await descriptor.close()
  }
}
function usageValue(session: Session, key: 'totalTokens' | 'costUsd'): number | undefined {
  const value = session.usage[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return
  if (key === 'totalTokens' && !Number.isSafeInteger(value)) return

  return value
}

function costType(value: unknown): 'provider_reported' | 'estimated' | 'unknown' {
  return value === 'provider_reported' || value === 'estimated' ? value : 'unknown'
}

function totals(sessions: Session[], key: 'totalTokens' | 'costUsd'): number | null {
  const values = sessions
    .map((session) => usageValue(session, key))
    .filter((value): value is number => value !== undefined)
  if (!values.length) return null

  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || (key === 'totalTokens' && !Number.isSafeInteger(total)))
    return null

  return total
}
async function revision(store: Store, root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dotenvFiles = entries
    .filter(
      (entry) => (entry.isFile() || entry.isSymbolicLink()) && /^\.env(?:\..*)?$/.test(entry.name)
    )
    .map((entry) => join(root, entry.name))
    .sort()

  const files = await Promise.all(
    [store.dbPath, `${store.dbPath}-wal`, join(root, 'rivalcode.config.json'), ...dotenvFiles].map(
      async (file) => {
        const metadata = await stat(file, { bigint: true }).catch(() => null)
        return metadata
          ? `${file}:${metadata.dev}:${metadata.ino}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.size}`
          : `${file}:absent`
      }
    )
  )

  return createHash('sha256').update(files.join('|')).digest('hex')
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
  app.onError(async (error, context) => {
    // Config validation can fail before request privacy exists. Use the mandatory
    // credential rules for diagnostics, and withhold details if those cannot load.
    const redact =
      context.get('privacy')?.redact ??
      (await createRedactor(root, defaultConfig).catch(() => null))
    const message = redact
      ? String(redact(error.message))
      : 'Local request failed; diagnostic redaction is unavailable.'

    if (error instanceof InputError) return context.json({ error: message }, 400)

    console.error('[RivalCode API]', message)
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
  app.get('/api/health', (context) =>
    context.json({ ok: true, version: RIVALCODE_VERSION, local: true })
  )
  let detection: ReturnType<typeof detectAdapters> | undefined
  let detectedAt = 0
  app.get('/api/agents', async (context) => {
    const { redact } = context.get('privacy')

    if (!detection || Date.now() - detectedAt > 30_000) {
      // Retain capture-time protections through credential rotation, then apply
      // current protections to the cached text on each response.
      detection = detectAdapters().then((agents) =>
        agents.map((agent) => safeDetection(agent, redact))
      )
      detectedAt = Date.now()
    }

    return context.json((await detection).map((agent) => safeDetection(agent, redact)))
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
    context.json(
      store.leaderboard(filters(context.req.query())).map((row) => ({
        ...row,
        costType: row.costType === 'mixed' ? 'mixed' : costType(row.costType)
      }))
    )
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
    const costs = sessions.filter((session) => usageValue(session, 'costUsd') !== undefined)
    const costTypes = new Set(costs.map((session) => costType(session.usage.costType)))
    const durations = sessions
      .map((session) => session.durationMs)
      .filter((duration) => Number.isSafeInteger(duration) && duration >= 0)

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
      averageDurationMs: durations.length
        ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
        : null,
      totalTokens: totals(sessions, 'totalTokens'),
      totalCostUsd: totals(sessions, 'costUsd'),
      tokensAvailableRuns: sessions.filter((s) => usageValue(s, 'totalTokens') !== undefined)
        .length,
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
      let previous = await revision(store, root)
      stream.onAbort(() => {
        running = false
      })
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ revision: previous }) })
      let ticks = 0
      while (running) {
        await stream.sleep(1000)
        if (!running) break
        const current = await revision(store, root)
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
