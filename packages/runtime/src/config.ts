import { access, lstat, mkdir, readFile, realpath, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CommandSpec, RivalConfig } from '@rivalcode/shared'

export const defaultConfig: RivalConfig = {
  version: 1,
  verification: { commands: [], runBaseline: false },
  setup: [],
  battle: { timeoutMinutes: 30, parallel: false, network: 'inherit' },
  privacy: {
    storeTaskPrompt: true,
    storeAssistantOutput: true,
    storeToolOutput: false,
    redactSecrets: true,
    customRedactions: []
  },
  scoring: { enabled: true, maxFiles: 40, maxLines: 3000 },
  ignore: ['node_modules/**', 'dist/**', 'build/**', '.next/**', 'coverage/**', '.rivalcode/**'],
  forbiddenPaths: ['.git/**', '.env', '.env.*'],
  agents: {},
  dashboard: { port: 4317 },
  limits: { maxArtifactBytes: 2 * 1024 * 1024, maxEventBytes: 64 * 1024 },
  pricing: {}
}

const commandSchema = z
  .object({
    id: z.string().min(1).max(120),
    command: z.string().min(1).max(16000).optional(),
    executable: z.string().min(1).max(4000).optional(),
    args: z.array(z.string().max(16000)).max(1000).optional(),
    required: z.boolean().default(true),
    shell: z.boolean().default(false),
    timeoutSeconds: z.number().positive().max(86400).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.command) === Boolean(value.executable))
      ctx.addIssue({ code: 'custom', message: 'Specify exactly one of command or executable' })
    if (value.command && value.args)
      ctx.addIssue({ code: 'custom', message: 'args requires executable' })

    try {
      resolveCommand(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
    }
  })

const configSchema = z
  .object({
    version: z.literal(1).default(1),
    verification: z
      .object({
        commands: z.array(commandSchema).max(100).default([]),
        runBaseline: z.boolean().default(false)
      })
      .strict()
      .default({ commands: [], runBaseline: false }),
    setup: z.array(commandSchema).max(100).default([]),
    battle: z
      .object({
        timeoutMinutes: z.number().positive().max(1440).default(30),
        parallel: z.boolean().default(false),
        network: z.enum(['inherit', 'deny']).default('inherit')
      })
      .strict()
      .default(defaultConfig.battle),
    privacy: z
      .object({
        storeTaskPrompt: z.boolean().default(true),
        storeAssistantOutput: z.boolean().default(true),
        storeToolOutput: z.boolean().default(false),
        redactSecrets: z.boolean().default(true),
        customRedactions: z
          .array(
            z
              .string()
              .min(1)
              .max(1024)
              .refine((value) => {
                try {
                  new RegExp(value, 'g')
                  return true
                } catch {
                  return false
                }
              }, 'Invalid redaction regular expression')
          )
          .max(100)
          .default([])
      })
      .strict()
      .default(defaultConfig.privacy),
    scoring: z
      .object({
        enabled: z.boolean().default(true),
        maxFiles: z.number().int().positive().max(100000).default(40),
        maxLines: z.number().int().positive().max(10000000).default(3000)
      })
      .strict()
      .default(defaultConfig.scoring),
    ignore: z.array(z.string().min(1).max(4000)).max(1000).default(defaultConfig.ignore),
    forbiddenPaths: z
      .array(z.string().min(1).max(4000))
      .max(1000)
      .default(defaultConfig.forbiddenPaths),
    agents: z
      .partialRecord(
        z.enum(['codex', 'claude', 'gemini', 'opencode', 'demo']),
        z
          .object({
            model: z.string().min(1).max(500).optional(),
            args: z.array(z.string().max(4000)).max(100).optional()
          })
          .strict()
      )
      .default({}),
    dashboard: z
      .object({ port: z.number().int().min(1024).max(65535).default(defaultConfig.dashboard.port) })
      .strict()
      .default(defaultConfig.dashboard),
    limits: z
      .object({
        maxArtifactBytes: z
          .number()
          .int()
          .min(1024)
          .max(64 * 1024 * 1024)
          .default(defaultConfig.limits.maxArtifactBytes),
        maxEventBytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024)
          .default(defaultConfig.limits.maxEventBytes)
      })
      .strict()
      .default(defaultConfig.limits),
    pricing: z
      .record(
        z.string().min(1).max(500),
        z
          .object({
            inputPerMillion: z.number().nonnegative(),
            outputPerMillion: z.number().nonnegative(),
            cachedInputPerMillion: z.number().nonnegative().optional()
          })
          .strict()
      )
      .default({})
  })
  .strict()

/** Tokenize portable commands without evaluating shell expansions or operators. */
export function splitCommand(command: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: string | undefined
  let started = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === '\0' || char === '\n' || char === '\r')
      throw new Error('Command must be a single line without NUL')

    if (quote) {
      if (char === quote) quote = undefined
      else if (char === '\\' && command[index + 1] === quote) token += command[++index]
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
    } else if ('|;&<>`'.includes(char) || (char === '$' && command[index + 1] === '('))
      throw new Error('Shell expressions require shell: true')
    else {
      token += char
      started = true
    }
  }

  if (quote) throw new Error('Unterminated command quote')
  if (started) tokens.push(token)
  if (!tokens[0]) throw new Error('Command executable is empty')

  return tokens
}

export function resolveCommand(
  spec: Pick<CommandSpec, 'command' | 'executable' | 'args' | 'shell'>
): { executable: string; args: string[]; shell: boolean } {
  if (spec.command) {
    if (spec.shell === true) {
      if (spec.command.includes('\0')) throw new Error('Command contains NUL')

      return { executable: spec.command, args: [], shell: true }
    }

    const parts = splitCommand(spec.command)

    return { executable: parts[0]!, args: parts.slice(1), shell: false }
  }

  if (
    !spec.executable ||
    spec.executable.includes('\0') ||
    spec.args?.some((arg) => arg.includes('\0'))
  )
    throw new Error('Invalid executable or arguments')

  return { executable: spec.executable, args: spec.args ?? [], shell: spec.shell === true }
}

export function validateConfig(input: unknown): RivalConfig {
  let normalized = input

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const object = { ...(input as Record<string, unknown>) }
    const verification = object.verification

    if (verification && typeof verification === 'object' && !Array.isArray(verification)) {
      const source = { ...(verification as Record<string, unknown>) }
      const commands = Array.isArray(source.commands) ? [...source.commands] : []
      if (source.commands !== undefined && !Array.isArray(source.commands))
        throw new Error('verification.commands must be an array')

      for (const key of ['test', 'lint', 'typecheck', 'build']) {
        const value = source[key]

        if (value === undefined) continue
        if (typeof value !== 'string')
          throw new Error(`verification.${key} must be a command string`)

        commands.push({ id: key, command: value, required: true })
        delete source[key]
      }

      object.verification = { ...source, ...(commands.length ? { commands } : {}) }
    }

    normalized = object
  }

  const config = structuredClone(configSchema.parse(normalized)) as RivalConfig

  for (const specs of [config.verification.commands, config.setup]) {
    const ids = new Set<string>()

    for (const spec of specs) {
      if (ids.has(spec.id)) throw new Error(`Duplicate command id: ${spec.id}`)
      ids.add(spec.id)
    }
  }

  return config
}

const exists = async (file: string) =>
  access(file).then(
    () => true,
    () => false
  )

export interface ProjectDetection {
  type: string
  packageManager?: string
  commands: CommandSpec[]
}

const check = (id: string, executable: string, args: string[]): CommandSpec => ({
  id,
  executable,
  args,
  required: true
})

export async function detectProject(root: string): Promise<ProjectDetection> {
  const has = (name: string) => exists(path.join(root, name))

  if (await has('package.json')) {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      packageManager?: string
      scripts?: Record<string, string>
    }

    let manager = pkg.packageManager?.split('@')[0]
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager ?? ''))
      manager = (await has('pnpm-lock.yaml'))
        ? 'pnpm'
        : (await has('yarn.lock'))
          ? 'yarn'
          : (await has('bun.lock')) || (await has('bun.lockb'))
            ? 'bun'
            : 'npm'

    return {
      type: 'node',
      packageManager: manager,
      commands: ['test', 'lint', 'typecheck', 'build']
        .filter((id) => pkg.scripts?.[id])
        .map((id) => check(id, manager!, ['run', id]))
    }
  }

  if (await has('Cargo.toml'))
    return {
      type: 'rust',
      commands: [
        check('test', 'cargo', ['test']),
        check('lint', 'cargo', ['clippy', '--', '-D', 'warnings']),
        check('build', 'cargo', ['build'])
      ]
    }

  if (await has('go.mod'))
    return {
      type: 'go',
      commands: [
        check('test', 'go', ['test', './...']),
        check('lint', 'go', ['vet', './...']),
        check('build', 'go', ['build', './...'])
      ]
    }

  if (
    (await has('build.gradle')) ||
    (await has('build.gradle.kts')) ||
    (await has('settings.gradle')) ||
    (await has('settings.gradle.kts'))
  ) {
    const executable =
      process.platform === 'win32' && (await has('gradlew.bat'))
        ? 'gradlew.bat'
        : (await has('gradlew'))
          ? './gradlew'
          : 'gradle'

    return {
      type: 'java-gradle',
      commands: [check('test', executable, ['test']), check('build', executable, ['build'])]
    }
  }

  if (await has('pom.xml')) {
    const executable =
      process.platform === 'win32' && (await has('mvnw.cmd'))
        ? 'mvnw.cmd'
        : (await has('mvnw'))
          ? './mvnw'
          : 'mvn'

    return {
      type: 'java-maven',
      commands: [check('test', executable, ['test']), check('build', executable, ['verify'])]
    }
  }

  if (
    (await has('pyproject.toml')) ||
    (await has('setup.py')) ||
    (await has('requirements.txt')) ||
    (await has('Pipfile'))
  ) {
    const metadata = await readFile(path.join(root, 'pyproject.toml'), 'utf8').catch(() => '')
    const commands = [check('test', 'python', ['-m', 'pytest'])]

    if (/\bruff\b/.test(metadata))
      commands.push(check('lint', 'python', ['-m', 'ruff', 'check', '.']))
    if (/\bmypy\b/.test(metadata)) commands.push(check('typecheck', 'python', ['-m', 'mypy', '.']))

    return { type: 'python', commands }
  }

  return { type: 'unknown', commands: [] }
}

export async function loadConfig(root: string): Promise<RivalConfig> {
  const file = path.join(root, 'rivalcode.config.json')

  try {
    return validateConfig(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig({})
    throw new Error(`Invalid rivalcode.config.json: ${(error as Error).message}`)
  }
}

export async function initRepository(root: string): Promise<RivalConfig> {
  const file = path.join(root, 'rivalcode.config.json')

  if (await exists(file)) {
    const config = await loadConfig(root)
    await ensureStateIgnored(root)

    return config
  }

  const detection = await detectProject(root)
  const config = validateConfig({ verification: { commands: detection.commands } })

  try {
    await writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  await ensureStateIgnored(root)

  return loadConfig(root)
}

async function ensureStateIgnored(root: string): Promise<void> {
  await mkdir(path.join(root, '.rivalcode'), { recursive: true })

  const actualRoot = await realpath(root)
  const actualState = await realpath(path.join(root, '.rivalcode'))
  const relative = path.relative(actualRoot, actualState)

  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('RivalCode state directory escapes the repository')

  const file = path.join(root, '.gitignore')
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })

  if (metadata?.isSymbolicLink()) throw new Error('Refusing to edit a symlinked .gitignore')
  if (metadata && metadata.nlink > 1) throw new Error('Refusing to edit a hard-linked .gitignore')
  if (metadata && !metadata.isFile()) throw new Error('.gitignore must be a regular file')

  const content = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })

  if (
    !content
      .split(/\r?\n/)
      .some((line) => line.trim() === '/.rivalcode/' || line.trim() === '.rivalcode/')
  )
    await appendFile(
      file,
      `${content && !content.endsWith('\n') ? '\n' : ''}\n# RivalCode local history and artifacts\n/.rivalcode/\n`
    )
}
