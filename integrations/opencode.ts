import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PreparedRun, RunContext } from '../packages/shared/src/index.js'
import { collectorSource } from './collector.js'

const ownership = '// rivalcode-owned:v1:opencode-observer\n'
export const openCodePluginSource =
  ownership +
  collectorSource +
  String.raw`export const RivalCodeObserver = async () => ({
  'tool.execute.before': async (input, output) => {
    hookTool('started', { tool: input.tool, callID: input.callID, args: output.args }, false)
  },
  'tool.execute.after': async (input, _output) => {
    // Native JSONL already exposes completion/output; no duplicated after event is stored.
    // This observer deliberately returns no changes to the tool result.
  },
  event: async ({ event }) => {
    const properties = event.properties || event.data || {}
    const sessionID = properties.sessionID || properties.sessionId
    if (event.type === 'session.created') observe('session_started', { sessionId: sessionID })
    else if (event.type === 'session.error')
      observe('error', {
        message:
          properties.error?.message || properties.error?.data?.message || 'OpenCode session failed',
        sessionId: sessionID
      })
    else if (event.type === 'file.edited') observeFile(properties.file || properties.path)
    else if (event.type === 'permission.asked' || event.type === 'permission.updated')
      observe('permission_requested', {
        permission: properties.permission || 'requested',
        sessionId: sessionID
      })
    else if (event.type === 'permission.replied')
      observe('permission_resolved', {
        permission: properties.reply || 'resolved',
        sessionId: sessionID
      })
    else if (event.type === 'message.updated') {
      const info = properties.info || properties.message || {}
      if (info.role === 'assistant' && typeof info.modelID === 'string')
        observe('usage', { model: (info.providerID ? info.providerID + '/' : '') + info.modelID })
    }
    // New OpenCode event transport: same allowlisted observer semantics.
    else if (event.type === 'session.tool.started')
      hookTool(
        'started',
        {
          tool: properties.tool,
          callID: properties.callID || properties.callId,
          args: properties.input || properties.args
        },
        false
      )
  }
})
`

async function rejectSymlink(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`Refusing to install an integration through a symbolic link: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function prepareOpenCodePlugin(
  ctx: RunContext
): Promise<Pick<PreparedRun, 'env' | 'cleanup'>> {
  const root = resolve(ctx.cwd)
  const configDir = join(root, '.opencode')
  const plugins = join(configDir, 'plugins')
  await rejectSymlink(configDir)
  await rejectSymlink(plugins)
  const configExisted = await lstat(configDir).then(
    () => true,
    () => false
  )
  const pluginsExisted = await lstat(plugins).then(
    () => true,
    () => false
  )
  await mkdir(plugins, { recursive: true })
  await mkdir(ctx.artifactDir, { recursive: true })
  const suffix = `${ctx.sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${randomUUID()}`
  const path = join(plugins, `rivalcode-${suffix}.js`)
  await writeFile(path, openCodePluginSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const capture = join(resolve(ctx.artifactDir), `opencode-capture-${suffix}.jsonl`)
  try {
    await writeFile(capture, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    await unlink(path)
    throw error
  }
  return {
    env: {
      RIVALCODE_CAPTURE_PATH: capture,
      RIVALCODE_PROJECT_ROOT: root,
      RIVALCODE_SESSION_ID: ctx.sessionId,
      RIVALCODE_CAPTURE_MAX_BYTES: String(ctx.config.limits.maxArtifactBytes),
      RIVALCODE_EVENT_MAX_BYTES: String(ctx.config.limits.maxEventBytes),
      RIVALCODE_REDACTIONS: JSON.stringify(ctx.config.privacy.customRedactions)
    },
    cleanup: async () => {
      await rejectSymlink(path)
      const current = await readFile(path, 'utf8').catch(() => null)
      if (current === openCodePluginSource) {
        await unlink(path)
        if (!pluginsExisted)
          await rmdir(plugins).catch((error) => {
            if (
              !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
                (error as NodeJS.ErrnoException).code ?? ''
              )
            )
              throw error
          })
        if (!configExisted)
          await rmdir(configDir).catch((error) => {
            if (
              !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
                (error as NodeJS.ErrnoException).code ?? ''
              )
            )
              throw error
          })
      }
    }
  }
}

/** Remove only unmodified files with RivalCode's exact plugin content. */
export async function uninstallHooks(root: string): Promise<{ removed: string[] }> {
  const resolved = resolve(root)
  const configDir = join(resolved, '.opencode')
  const plugins = join(configDir, 'plugins')
  await rejectSymlink(configDir)
  await rejectSymlink(plugins)
  const removed: string[] = []
  let names: string[]
  try {
    names = await readdir(plugins)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed }
    throw error
  }
  for (const name of names) {
    if (!/^rivalcode-[A-Za-z0-9_-]+\.js$/.test(name)) continue
    const path = join(plugins, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) continue
    if ((await readFile(path, 'utf8')) === openCodePluginSource) {
      await unlink(path)
      removed.push(path)
    }
  }
  return { removed }
}
