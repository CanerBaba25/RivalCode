import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { mkdir, realpath, writeFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { getAdapter, JsonlParser } from '@rivalcode/adapters'
import {
  Store,
  loadConfig,
  createRedactor,
  gitRoot,
  getHead,
  getRemote,
  assertClean,
  captureGit,
  snapshotCommit,
  createWorktree,
  removeWorktree,
  executeVerification,
  runProcess,
  detectProject
} from '@rivalcode/runtime'
import type {
  AgentId,
  Battle,
  EventInput,
  NormalizedEvent,
  RunOptions,
  Session,
  RivalConfig,
  RepositoryRecord
} from '@rivalcode/shared'
import { makeEvent, mergeUsage } from './events.js'
import { detectFindings } from './findings.js'
import { rankBattle, scoreRun } from './scoring.js'

function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate)

  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function stateDirectory(state: string, segments: string[]) {
  let current = await realpath(state)
  const boundary = current

  for (const segment of segments) {
    if (!/^[a-zA-Z0-9_-]+$/.test(segment)) throw new Error('Invalid RivalCode state path')

    current = path.join(current, segment)

    try {
      const info = await lstat(current)

      if (info.isSymbolicLink())
        throw new Error('RivalCode refuses a symlink in an owned state path')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
    }

    if (!within(boundary, await realpath(current)))
      throw new Error('RivalCode state path escapes the repository')
  }

  return current
}

export async function repositoryRecord(
  root: string,
  redact: (value: unknown) => unknown
): Promise<RepositoryRecord> {
  return redact({
    id: createHash('sha256').update(root).digest('hex').slice(0, 24),
    path: root,
    name: path.basename(root),
    remoteUrl: String(redact((await getRemote(root)) ?? '')) || undefined,
    projectType: (await detectProject(root)).type,
    createdAt: new Date().toISOString()
  }) as RepositoryRecord
}

export async function runAgent(options: RunOptions): Promise<Session> {
  const root = await gitRoot(options.root)
  const config = options.config ?? (await loadConfig(root))
  const redact = await createRedactor(root, config)
  const store = options.store instanceof Store ? options.store : new Store(root)
  const ownStore = !(options.store instanceof Store)
  const repository = await repositoryRecord(root, redact)

  store.upsertRepository(repository)

  const id = 'rc_' + randomUUID().replaceAll('-', '')
  const artifactDir = await stateDirectory(store.stateDir, ['sessions', id])
  const adapter = getAdapter(options.agent, options.demo === true)
  const started = Date.now()

  const session: Session = {
    id,
    repositoryId: repository.id,
    repositoryPath: root,
    repositoryName: repository.name,
    agentId: options.agent,
    agentVersion: null,
    task: config.privacy.storeTaskPrompt ? String(redact(options.task)) : null,
    baseCommit: await getHead(options.cwd ?? root),
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    status: 'preparing',
    score: null,
    exitCode: null,
    usage: {},
    files: [],
    findings: [],
    verification: [],
    capabilities: adapter.capabilities,
    artifactDir,
    worktreePath: options.cwd,
    battleId: options.battleId,
    pid: process.pid,
    demo: options.demo === true,
    tags: redact(options.tags ?? []) as string[]
  }

  store.saveSession(redact(session) as Session)

  const events: NormalizedEvent[] = []
  let artifactBytes = 0
  let evidenceLimited = false
  let nativeFailure: string | undefined

  const emit = (input: EventInput) => {
    const event = makeEvent(input, id, options.agent, config, redact)

    if (!event) return

    if (event.payload.fatal === true) {
      nativeFailure ??= String(
        event.payload.message ?? event.payload.error ?? 'Agent reported a terminal failure'
      )
    }

    store.appendEvents([event])

    if (event.type === 'usage' || event.type === 'cost') {
      session.usage = mergeUsage(session.usage, event.payload, config)
      if (session.usage.model) session.model = session.usage.model
      store.saveSession(redact(session) as Session)
    }

    if (event.type === 'session_started' && typeof event.payload.model === 'string') {
      session.model = event.payload.model
      store.saveSession(redact(session) as Session)
    }

    // Keep only bounded analysis evidence in memory; the full timeline remains paginated in SQLite.
    if (
      [
        'command_started',
        'command_finished',
        'tool_finished',
        'file_changed',
        'error',
        'session_finished'
      ].includes(event.type)
    ) {
      if (events.length < 20000) events.push(event)
      else {
        evidenceLimited = true
        if (event.payload.fatal === true) events[events.length - 1] = event
      }
    }

    const line = JSON.stringify(event) + '\n'
    const bytes = Buffer.byteLength(line)

    if (artifactBytes + bytes <= config.limits.maxArtifactBytes) {
      appendFileSync(path.join(artifactDir, 'events.jsonl'), line, { mode: 0o600 })
      artifactBytes += bytes
    }

    options.onEvent?.(event)
  }

  const progress = (message: string) => options.onProgress?.(message)
  const cwd = options.cwd ?? root
  const parser = new JsonlParser(config.limits.maxEventBytes)
  const captureParser = new JsonlParser(config.limits.maxEventBytes)
  let prepared: Awaited<ReturnType<typeof adapter.prepareRun>> | undefined
  let captureTimer: ReturnType<typeof setInterval> | undefined
  let captureOffset = 0
  const captureDecoder = new StringDecoder('utf8')

  const parse = (records: unknown[]) => {
    for (const record of records) for (const input of adapter.parseEvent(record)) emit(input)
  }

  const capture = () => {
    const file = prepared?.env?.RIVALCODE_CAPTURE_PATH

    if (!file || !existsSync(file)) return

    const size = statSync(file).size

    if (size > config.limits.maxArtifactBytes)
      throw new Error('Integration capture exceeded the configured artifact limit')
    if (size <= captureOffset) return

    const descriptor = openSync(file, 'r')

    try {
      const chunk = Buffer.alloc(size - captureOffset)
      const read = readSync(descriptor, chunk, 0, chunk.length, captureOffset)
      captureOffset += read
      parse(captureParser.push(captureDecoder.write(chunk.subarray(0, read))))
    } finally {
      closeSync(descriptor)
    }
  }

  let interrupted = false
  let baselineCommit: string | undefined
  let diagnostic = ''

  try {
    progress(`Session ${id}: capturing baseline`)
    emit({
      type: 'session_started',
      source: 'rivalcode',
      payload: { demo: session.demo, baseCommit: session.baseCommit }
    })
    emit({ type: 'task', source: 'rivalcode', payload: { text: options.task } })
    baselineCommit = await snapshotCommit(cwd, config.ignore)

    const detection = await adapter.detect()
    session.agentVersion = detection.version

    if (!detection.installed)
      throw new Error(
        `${adapter.displayName} was not found on PATH. Run rivalcode doctor for setup help.`
      )
    if (options.signal?.aborted) throw new Error('Run cancelled before agent startup')

    const setup = await executeVerification(
      cwd,
      id,
      config.setup,
      'setup',
      config,
      artifactDir,
      redact,
      options.signal,
      emit
    )

    session.verification.push(...setup)
    store.saveSession(redact(session) as Session)

    if (setup.some((check) => !check.passed))
      throw new Error('Repository setup failed; inspect the persisted setup verification')

    baselineCommit = await snapshotCommit(cwd, config.ignore)

    if (config.verification.runBaseline) {
      progress('Running baseline verification')
      session.verification.push(
        ...(await executeVerification(
          cwd,
          id,
          config.verification.commands,
          'baseline',
          config,
          artifactDir,
          redact,
          options.signal,
          emit
        ))
      )
    }

    session.status = 'running'
    session.model = config.agents[options.agent]?.model
    store.saveSession(redact(session) as Session)

    prepared = await adapter.prepareRun({
      sessionId: id,
      cwd,
      task: options.task,
      config,
      model: session.model,
      artifactDir,
      demo: session.demo
    })

    let captureError: Error | undefined

    if (prepared.env?.RIVALCODE_CAPTURE_PATH)
      captureTimer = setInterval(() => {
        try {
          capture()
        } catch (error) {
          captureError = error instanceof Error ? error : new Error(String(error))
        }
      }, 100)

    progress(`Starting ${adapter.displayName}`)

    const result = await runProcess(prepared.executable, prepared.args, {
      cwd,
      env: prepared.env,
      stdin: prepared.stdin,
      signal: options.signal,
      timeoutMs: config.battle.timeoutMinutes * 60000,
      // Agent output is streamed through allowlisted native parsers and never retained raw.
      maxOutputBytes: 0,
      onStdout: (chunk) => parse(parser.push(chunk)),
      onStderr: (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-8192)
      }
    })

    parse(parser.finish())

    if (captureTimer) {
      clearInterval(captureTimer)
      captureTimer = undefined
    }

    capture()
    parse(captureParser.push(captureDecoder.end()))
    parse(captureParser.finish())

    if (captureError) throw captureError

    await prepared.cleanup?.()
    prepared = undefined

    session.exitCode = result.exitCode
    interrupted = result.aborted || result.timedOut

    if (result.timedOut)
      session.error = 'Agent timed out; partial evidence and the worktree were preserved.'
    if (result.aborted) session.error = 'Agent run was cancelled; partial evidence was preserved.'
    if (nativeFailure && !session.error) session.error = nativeFailure
    if (result.exitCode !== 0 && !session.error)
      session.error = `Agent exited with ${result.exitCode ?? result.signal ?? 'no exit code'}. Check authentication and permissions with rivalcode doctor.`

    if (result.exitCode !== 0 && diagnostic.trim()) {
      session.error += ' ' + String(redact(diagnostic.trim()))
      emit({ type: 'error', source: 'process', payload: { message: session.error } })
    }

    session.status = 'verifying'
    store.saveSession(redact(session) as Session)

    progress('Running independent final verification')
    session.verification.push(
      ...(await executeVerification(
        cwd,
        id,
        config.verification.commands,
        'final',
        config,
        artifactDir,
        redact,
        options.signal,
        emit
      ))
    )

    progress('Capturing Git diff and findings')
    const git = await captureGit(cwd, baselineCommit, config.ignore)
    session.files = git.files
    const diff = String(redact(git.diff))
    const bytes = Buffer.from(diff)
    const bounded =
      bytes.length > config.limits.maxArtifactBytes
        ? bytes.subarray(0, config.limits.maxArtifactBytes).toString('utf8') +
          '\n[RivalCode diff truncated]\n'
        : diff

    await writeFile(path.join(artifactDir, 'final.diff'), bounded, { mode: 0o600, flag: 'wx' })

    for (const file of session.files)
      emit({
        type: 'file_changed',
        source: 'git',
        payload: { ...file, observation: 'final Git diff; not an intermediate edit snapshot' }
      })

    session.durationMs = Date.now() - started
    interrupted ||= options.signal?.aborted === true

    emit({
      type: 'session_finished',
      source: 'rivalcode',
      payload: {
        exitCode: session.exitCode,
        durationMs: session.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted || options.signal?.aborted === true
      }
    })

    session.findings = detectFindings(events, session.files, session.verification, config)

    if (evidenceLimited)
      session.findings.push({
        id: randomUUID(),
        type: 'analysis_limit',
        severity: 'info',
        title: 'Analysis evidence limit reached',
        detail:
          'Findings use the first 20,000 relevant events. The complete persisted timeline remains available.',
        evidence: {}
      })

    interrupted ||= options.signal?.aborted === true

    session.score = config.scoring.enabled
      ? scoreRun(
          {
            verification: session.verification,
            files: session.files,
            findings: session.findings,
            events,
            durationMs: session.durationMs,
            exitCode: session.exitCode,
            aborted: interrupted
          },
          config
        )
      : null

    session.status = interrupted
      ? 'aborted'
      : !nativeFailure &&
          session.exitCode === 0 &&
          session.verification
            .filter((v) => v.phase === 'final' && v.required)
            .every((v) => v.passed)
        ? 'completed'
        : 'failed'

    for (const finding of session.findings)
      emit({ type: 'finding', source: 'rivalcode', payload: { ...finding } })
  } catch (error) {
    session.error = String(redact(error instanceof Error ? error.message : String(error)))
    session.status = options.signal?.aborted ? 'aborted' : 'failed'

    emit({ type: 'error', source: 'rivalcode', payload: { message: session.error } })

    // Partial failures still retain a safe final patch where Git remains available.
    try {
      const partial = baselineCommit
        ? await captureGit(cwd, baselineCommit, config.ignore)
        : { files: [], diff: '' }
      session.files = partial.files
      const safe = String(redact(partial.diff))

      await writeFile(
        path.join(artifactDir, 'final.diff'),
        Buffer.from(safe).subarray(0, config.limits.maxArtifactBytes),
        { mode: 0o600 }
      )
    } catch (captureFailure) {
      emit({
        type: 'error',
        source: 'git',
        payload: {
          message: 'Partial Git capture failed: ' + String(redact(String(captureFailure)))
        }
      })
    }

    emit({
      type: 'session_finished',
      source: 'rivalcode',
      payload: { status: session.status, error: session.error }
    })
  } finally {
    if (captureTimer) clearInterval(captureTimer)

    try {
      await prepared?.cleanup?.()
    } catch (error) {
      session.error = [
        session.error,
        'Integration cleanup failed: ' + String(redact(String(error)))
      ]
        .filter(Boolean)
        .join('; ')
      if (session.status === 'completed') session.status = 'failed'
    }

    if (options.signal?.aborted) {
      session.status = 'aborted'
      if (session.score) {
        session.score.requiredPassed = false
        session.score.reliability = 0
        session.score.total = Math.min(49, session.score.total)
        session.score.explanation.push('Run interrupted; score capped at 49.')
      }
    }

    session.finishedAt = new Date().toISOString()
    session.durationMs = Date.now() - started
    store.saveSession(redact(session) as Session)

    await writeFile(
      path.join(artifactDir, 'metadata.json'),
      JSON.stringify(redact(session), null, 2),
      {
        mode: 0o600
      }
    )

    await writeFile(
      path.join(artifactDir, 'verification.json'),
      JSON.stringify(redact(session.verification), null, 2),
      { mode: 0o600 }
    )

    await writeFile(
      path.join(artifactDir, 'findings.json'),
      JSON.stringify(redact(session.findings), null, 2),
      { mode: 0o600 }
    )

    if (ownStore) store.close()
  }

  progress(`Session ${id}: ${session.status}`)

  return redact(session) as Session
}

export interface BattleOptions {
  root: string
  agents: AgentId[]
  task: string
  demo?: boolean
  parallel?: boolean
  config?: RivalConfig
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

export async function runBattle(options: BattleOptions): Promise<Battle> {
  const root = await gitRoot(options.root)
  await assertClean(root)

  const baseCommit = await getHead(root)
  const config = structuredClone(options.config ?? (await loadConfig(root)))

  if (options.parallel !== undefined) config.battle.parallel = options.parallel
  if (!options.agents.length || new Set(options.agents).size !== options.agents.length)
    throw new Error('Battle agents must be a nonempty list without duplicates')

  for (const id of options.agents) getAdapter(id, options.demo === true)

  const redact = await createRedactor(root, config)
  const store = new Store(root)
  const repository = await repositoryRecord(root, redact)
  store.upsertRepository(repository)

  const battle: Battle = {
    id: 'battle_' + randomUUID().replaceAll('-', ''),
    repositoryId: repository.id,
    repositoryName: repository.name,
    task: config.privacy.storeTaskPrompt ? String(redact(options.task)) : null,
    baseCommit,
    startedAt: new Date().toISOString(),
    status: 'preparing',
    sessionIds: [],
    winnerSessionId: null,
    tiedSessionIds: [],
    ranking: [],
    config: redact(config) as RivalConfig
  }

  store.saveBattle(redact(battle) as Battle)

  const sessions: Session[] = []

  try {
    const directory = await stateDirectory(store.stateDir, ['worktrees', battle.id])

    const run = async (agent: AgentId) => {
      if (options.signal?.aborted) return

      const worktree = path.join(directory, agent)
      let session: Session

      try {
        await createWorktree(root, worktree, baseCommit)
        session = await runAgent({
          root,
          cwd: worktree,
          agent,
          task: options.task,
          config: structuredClone(config),
          store,
          battleId: battle.id,
          demo: options.demo,
          signal: options.signal,
          onProgress: options.onProgress
        })
      } catch (error) {
        const startedAt = new Date().toISOString()
        const id = 'rc_' + randomUUID().replaceAll('-', '')
        const artifactDir = await stateDirectory(store.stateDir, ['sessions', id])
        const message = String(redact(error instanceof Error ? error.message : String(error)))

        session = {
          id,
          repositoryId: repository.id,
          repositoryPath: root,
          repositoryName: repository.name,
          agentId: agent,
          agentVersion: null,
          task: battle.task,
          baseCommit,
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
          status: options.signal?.aborted ? 'aborted' : 'failed',
          score: null,
          exitCode: null,
          usage: {},
          files: [],
          findings: [],
          verification: [],
          capabilities: getAdapter(agent, options.demo === true).capabilities,
          artifactDir,
          worktreePath: existsSync(worktree) ? worktree : undefined,
          battleId: battle.id,
          error: message,
          pid: process.pid,
          demo: options.demo === true,
          tags: []
        }

        store.saveSession(redact(session) as Session)

        const event = makeEvent(
          { type: 'error', source: 'rivalcode', payload: { message } },
          id,
          agent,
          config,
          redact
        )

        if (event) store.appendEvents([event])

        await writeFile(
          path.join(artifactDir, 'metadata.json'),
          JSON.stringify(redact(session), null, 2),
          {
            mode: 0o600
          }
        )

        options.onProgress?.(`${agent} preparation failed: ${message}`)
      }

      sessions.push(session)
      battle.sessionIds.push(session.id)
      store.saveBattle(redact(battle) as Battle)

      if (session.status === 'completed') {
        try {
          await removeWorktree(root, worktree)
        } catch (error) {
          options.onProgress?.(`Worktree preserved for cleanup: ${String(redact(String(error)))}`)
        }
      }
    }

    battle.status = 'running'
    store.saveBattle(redact(battle) as Battle)

    if (config.battle.parallel) {
      options.onProgress?.(
        'Parallel mode may reduce fairness through CPU, disk, network and rate-limit interference.'
      )

      const results = await Promise.allSettled(options.agents.map(run))
      const failed = results.find((result) => result.status === 'rejected')

      if (failed?.status === 'rejected') throw failed.reason
    } else {
      for (const agent of options.agents) await run(agent)
    }

    Object.assign(battle, rankBattle(sessions))
    battle.status = options.signal?.aborted
      ? 'aborted'
      : sessions.length === options.agents.length
        ? 'completed'
        : 'failed'
  } catch (error) {
    battle.status = options.signal?.aborted ? 'aborted' : 'failed'
    throw error
  } finally {
    battle.finishedAt = new Date().toISOString()
    store.saveBattle(redact(battle) as Battle)
    store.close()
  }

  return redact(battle) as Battle
}

export async function cleanupRuns(rootInput: string) {
  const root = await gitRoot(rootInput)
  const redact = await createRedactor(root, await loadConfig(root))
  const store = new Store(root)
  const recovered = store.recoverIncomplete()
  const removed: string[] = []

  try {
    for (let offset = 0; ; offset += 500) {
      const page = store.listSessions({ limit: 500, offset })

      for (const session of page.items) {
        if (!session.worktreePath || ['preparing', 'running', 'verifying'].includes(session.status))
          continue

        const boundary = path.join(store.stateDir, 'worktrees')
        let worktree = session.worktreePath

        if (worktree.includes('[REDACTED]')) {
          if (
            !session.battleId ||
            !/^battle_[a-f0-9]{32}$/.test(session.battleId) ||
            !['codex', 'claude', 'gemini', 'opencode', 'demo'].includes(session.agentId)
          )
            throw new Error('Cleanup refused an invalid owned worktree identifier')

          worktree = path.join(boundary, session.battleId, session.agentId)
        }

        if (!within(boundary, path.resolve(worktree)))
          throw new Error('Cleanup refused a worktree path outside RivalCode state')

        if (existsSync(worktree)) {
          await removeWorktree(root, worktree)
          removed.push(worktree)
        }
      }

      if (offset + page.items.length >= page.total) break
    }

    return redact({ recovered, removed }) as { recovered: string[]; removed: string[] }
  } finally {
    store.close()
  }
}
