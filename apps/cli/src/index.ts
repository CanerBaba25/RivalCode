import { Command, CommanderError, InvalidArgumentError } from 'commander'
import { open, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import {
  Store,
  initRepository,
  loadConfig,
  gitRoot,
  runProcess,
  detectProject,
  createRedactor,
  normalizeDateBound,
  defaultConfig
} from '@rivalcode/runtime'
import { detectAdapters, getAdapter, uninstallHooks } from '@rivalcode/adapters'
import { runAgent, runBattle, cleanupRuns, exportRecord, redactSession } from '@rivalcode/core'
import { startServer } from '@rivalcode/server'
import { RIVALCODE_VERSION, type AgentId } from '@rivalcode/shared'

const program = new Command()
program.exitOverride().configureOutput({
  outputError: () => {
    // Report parser errors through the same redaction boundary as command failures.
  }
})

program
  .name('rivalcode')
  .description('Benchmark coding agents on your repository. Same task. Real evidence.')
  .version(RIVALCODE_VERSION)
  .option('--repo <path>', 'repository directory', process.cwd())
  .option('--debug', 'show diagnostic stack traces')

const root = async () => gitRoot(path.resolve(String(program.opts().repo)))
const json = (value: unknown) => console.log(JSON.stringify(value, null, 2))

async function diagnosticRedactor(cwd: string) {
  let repository = cwd
  try {
    repository = await gitRoot(cwd)
  } catch {
    // Doctor also works outside a Git repository.
  }

  let config = structuredClone(defaultConfig)
  try {
    config = await loadConfig(repository)
  } catch {
    // Invalid configuration still needs credential-safe diagnostics.
  }

  try {
    return await createRedactor(repository, config)
  } catch {
    return (_value: unknown) =>
      'Diagnostics withheld because secret protection could not be initialized'
  }
}

const positive = (value: string) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0)
    throw new InvalidArgumentError('Expected a positive integer')
  return number
}
const agentId = (value: string): AgentId => {
  if (!['codex', 'claude', 'gemini', 'opencode', 'demo'].includes(value))
    throw new InvalidArgumentError(`Unknown agent: ${value}`)
  return value as AgentId
}

function dateBound(value: string, endOfDay = false): string {
  try {
    return normalizeDateBound(value, endOfDay)
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error))
  }
}

const abortable = async <T>(work: (signal: AbortSignal) => Promise<T>) => {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    return await work(controller.signal)
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
async function taskInput(options: { task?: string; taskFile?: string }) {
  if (Boolean(options.task) === Boolean(options.taskFile))
    throw new Error('Provide exactly one of --task or --task-file')
  let task = options.task

  if (task === undefined) {
    const file = await open(path.resolve(options.taskFile!), 'r')
    try {
      const maximum = 1024 * 1024
      const info = await file.stat()
      if (!info.isFile() || info.size > maximum)
        throw new Error('Task file must be a regular file under 1 MiB')

      const bytes = Buffer.alloc(maximum + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }

      if (length > maximum) throw new Error('Task file exceeds 1 MiB')
      task = bytes.subarray(0, length).toString('utf8')
    } finally {
      await file.close()
    }
  }

  if (!task.trim() || Buffer.byteLength(task) > 1024 * 1024)
    throw new Error('Task must be nonempty and under 1 MiB')
  return task
}
async function portAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

program
  .command('init')
  .description(
    'Create validated project configuration and local history without overwriting existing configuration'
  )
  .action(async () => {
    const config = await initRepository(await root())
    console.log('RivalCode initialized. Existing configuration is preserved.')
    console.log(
      `${config.verification.commands.length} verification commands configured. Review rivalcode.config.json before running agents.`
    )
  })

program
  .command('doctor')
  .description('Check Git, configuration, database, agent readiness and dashboard port')
  .option('--json', 'machine-readable report')
  .action(async (options) => {
    const reports: Record<string, unknown> = { node: process.version }
    const cwd = path.resolve(String(program.opts().repo))
    const redact = await diagnosticRedactor(cwd)
    const git = await runProcess('git', ['--version'], {
      cwd,
      timeoutMs: 5000,
      maxOutputBytes: 1000
    })
    reports.git = { installed: git.exitCode === 0, version: git.stdout.trim() || null }
    let repository: string | undefined
    try {
      repository = await gitRoot(cwd)
      reports.repository = repository
    } catch (error) {
      reports.repository = { error: error instanceof Error ? error.message : String(error) }
    }
    if (repository) {
      try {
        const config = await loadConfig(repository)
        reports.verification = config.verification.commands
        reports.forbiddenPaths = config.forbiddenPaths
        reports.port = {
          value: config.dashboard.port,
          available: await portAvailable(config.dashboard.port)
        }
        reports.project = await detectProject(repository)
        const store = new Store(repository)
        reports.database = 'ready'
        reports.recovered = store.recoverIncomplete()
        store.close()
      } catch (error) {
        reports.configuration = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    reports.agents = await detectAdapters()
    reports.integrations = {
      codex: 'native JSON stream; no hook required',
      claude: 'native JSON stream; no hook required',
      gemini: 'native JSON stream; no hook required',
      opencode: 'temporary session-owned observer; installed when a run starts'
    }
    const safeReports = redact(reports)

    if (options.json) json(safeReports)
    else {
      console.log('RivalCode Doctor\n')
      for (const [key, value] of Object.entries(
        typeof safeReports === 'object' && safeReports !== null
          ? safeReports
          : { error: safeReports }
      ))
        console.log(
          `${key.padEnd(15)} ${typeof value === 'string' ? value : JSON.stringify(value)}`
        )
      console.log(
        '\nAuthentication readiness reflects native status or configured credentials, not model entitlement. Missing optional agents do not block other adapters.'
      )
    }
  })

program
  .command('adapters')
  .description('List installed supported agents and observable capture capabilities')
  .option('--json', 'machine-readable report')
  .action(async (options) => {
    const redact = await diagnosticRedactor(path.resolve(String(program.opts().repo)))
    const agents = redact(await detectAdapters()) as Awaited<ReturnType<typeof detectAdapters>>
    if (options.json) json(agents)
    else
      for (const agent of agents)
        console.log(
          `${agent.displayName.padEnd(14)} ${agent.installed ? (agent.version ?? 'installed') : 'not installed'} | auth: ${agent.auth} | capture: ${agent.capabilities.structuredEvents ? 'native structured' : 'process and Git'}`
        )
  })

program
  .command('run')
  .argument('<agent>', 'codex, claude, gemini, opencode or explicit demo', agentId)
  .description('Run one real agent, record events and independently verify its patch')
  .option('--task <text>', 'task prompt')
  .option('--task-file <path>', 'read a task from a file')
  .option('--model <id>', 'requested agent model')
  .option('--demo', 'explicitly allow the labeled Demo Agent')
  .option('--tag <tags>', 'comma-separated task tags')
  .option('--json', 'machine-readable final session')
  .action(async (agent: AgentId, options) => {
    const repo = await root()
    const config = await loadConfig(repo)
    const task = await taskInput(options)
    if (options.model) config.agents[agent] = { ...config.agents[agent], model: options.model }
    getAdapter(agent, options.demo === true)
    const store = new Store(repo)
    const recovered = store.recoverIncomplete()
    store.close()
    if (recovered.length && !options.json)
      console.log(
        `Recovered ${recovered.length} interrupted sessions. See rivalcode sessions --incomplete.`
      )
    const session = await abortable((signal) =>
      runAgent({
        root: repo,
        agent,
        config,
        task,
        demo: options.demo,
        signal,
        tags: options.tag?.split(',').filter(Boolean),
        onProgress: options.json ? undefined : console.log
      })
    )
    if (options.json) json(session)
    else
      console.log(
        `Score: ${session.score?.total ?? 'N/A'} | Session: ${session.id}\nDashboard: http://127.0.0.1:${config.dashboard.port}/sessions/${session.id}`
      )
    if (session.status !== 'completed') process.exitCode = 1
  })

program
  .command('battle')
  .description('Run participants from the same clean commit in isolated Git worktrees')
  .requiredOption('--agents <list>', 'comma-separated participants')
  .option('--task <text>', 'shared task prompt')
  .option('--task-file <path>', 'shared task file')
  .option('--parallel', 'explicitly run concurrently; may reduce fairness')
  .option('--demo', 'allow labeled Demo Agent')
  .option('--json', 'machine-readable battle result')
  .action(async (options) => {
    const repo = await root()
    const agents = String(options.agents)
      .split(',')
      .map((value) => agentId(value.trim()))
    const task = await taskInput(options)
    const battle = await abortable((signal) =>
      runBattle({
        root: repo,
        agents,
        task,
        demo: options.demo,
        parallel: options.parallel,
        signal,
        onProgress: options.json ? undefined : console.log
      })
    )
    if (options.json) json(battle)
    else console.log(await exportRecord(repo, battle.id, 'markdown'))
    if (battle.status !== 'completed' || (!battle.winnerSessionId && !battle.tiedSessionIds.length))
      process.exitCode = 1
  })

program
  .command('sessions')
  .description('List persisted sessions')
  .option('--agent <id>', 'agent filter')
  .option('--status <status>', 'status filter')
  .option('--from <date>', 'start date', (value) => dateBound(value))
  .option('--to <date>', 'end date', (value) => dateBound(value, true))
  .option('--incomplete', 'show interrupted or active runs')
  .option('--limit <count>', 'page size', positive, 50)
  .option('--json', 'machine-readable page')
  .action(async (options) => {
    if (options.from && options.to && options.from > options.to)
      throw new Error('Start date must precede end date.')

    const repo = await root()
    const config = await loadConfig(repo)
    const redact = await createRedactor(repo, config)
    const store = new Store(repo)

    try {
      store.recoverIncomplete()
      const page = store.listSessions({
        agent: options.agent,
        status: options.status,
        from: options.from,
        to: options.to,
        incomplete: options.incomplete,
        limit: options.limit
      })
      const sessions = page.items.map((session) => redactSession(session, redact, config))

      if (options.json) json({ ...page, items: sessions })
      else {
        for (const session of sessions)
          console.log(
            `${session.id}  ${session.demo ? 'Demo Agent' : session.agentId}  ${session.status}  ${session.score?.total ?? 'N/A'}  ${(session.durationMs / 1000).toFixed(1)}s  ${session.task ?? '[prompt not stored]'}`
          )
        console.log(`${page.total} sessions`)
      }
    } finally {
      store.close()
    }
  })

program
  .command('show')
  .argument('<id>', 'session or battle ID')
  .description('Inspect persisted evidence')
  .option('--json', 'JSON instead of Markdown')
  .action(async (id, options) =>
    console.log(await exportRecord(await root(), id, options.json ? 'json' : 'markdown'))
  )
program
  .command('export')
  .argument('<id>')
  .description('Export a session or battle, including measured evidence')
  .option('--format <format>', 'json or markdown', 'markdown')
  .option('--output <file>', 'write to a file without overwriting an existing file')
  .action(async (id, options) => {
    if (!['json', 'markdown'].includes(options.format))
      throw new Error('Format must be json or markdown')
    const content = await exportRecord(await root(), id, options.format)
    if (options.output) {
      await writeFile(path.resolve(options.output), content, { flag: 'wx', mode: 0o600 })
      console.log(`Exported ${id}`)
    } else console.log(content)
  })
program
  .command('cleanup')
  .description('Recover dead runs and remove only RivalCode-owned inactive worktrees')
  .action(async () => json(await cleanupRuns(await root())))
program
  .command('uninstall-hooks')
  .description('Remove only RivalCode-owned integrations without modifying user configuration')
  .action(async () => json(await uninstallHooks(await root())))

async function webDirectory() {
  const adjacent = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web')
  try {
    await access(path.join(adjacent, 'index.html'))
    return adjacent
  } catch {
    const development = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../dist/web'
    )
    try {
      await access(path.join(development, 'index.html'))
      return development
    } catch {
      throw new Error('Dashboard assets are missing. Run pnpm build before opening the dashboard.')
    }
  }
}
program
  .command('dashboard')
  .description('Start the local API and bundled dashboard')
  .option('--port <number>', 'local port', positive)
  .option('--no-open', 'do not launch the browser')
  .action(async (options) => {
    const repo = await root()
    const config = await loadConfig(repo)
    const server = await startServer(repo, {
      port: options.port ?? config.dashboard.port,
      webDir: await webDirectory()
    })
    console.log(`RivalCode dashboard: ${server.url}\nPress Ctrl+C to stop.`)
    if (options.open) {
      const [executable, args] =
        process.platform === 'win32'
          ? ['rundll32.exe', ['url.dll,FileProtocolHandler', server.url]]
          : process.platform === 'darwin'
            ? ['open', [server.url]]
            : ['xdg-open', [server.url]]
      const opened = await runProcess(executable as string, args as string[], {
        cwd: repo,
        timeoutMs: 5000,
        maxOutputBytes: 0
      })
      if (opened.exitCode !== 0) console.log('Open the dashboard URL in your browser.')
    }
    await abortable(
      (signal) =>
        new Promise<void>((resolve) => {
          const shutdown = () => {
            void server.close().then(resolve)
          }
          signal.addEventListener('abort', shutdown, { once: true })
          if (signal.aborted) shutdown()
        })
    )
  })

program.parseAsync().catch(async (error) => {
  if (error instanceof CommanderError && error.exitCode === 0) return

  const redact = await diagnosticRedactor(path.resolve(String(program.opts().repo)))
  console.error(`RivalCode: ${redact(error instanceof Error ? error.message : String(error))}`)
  if (program.opts().debug && error instanceof Error) console.error(redact(error.stack))
  process.exitCode = 1
})
