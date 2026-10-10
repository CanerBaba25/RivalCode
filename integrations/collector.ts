/** Self-contained observer code, embedded into temporary project plugins and packed CLI. */
export const collectorSource = String.raw`import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'

const CAPTURE_PATH = process.env.RIVALCODE_CAPTURE_PATH
const CAPTURE_SESSION = process.env.RIVALCODE_SESSION_ID
const MAX_BYTES = Math.min(Number(process.env.RIVALCODE_CAPTURE_MAX_BYTES) || 10485760, 104857600)
const MAX_EVENT_BYTES = Math.min(Number(process.env.RIVALCODE_EVENT_MAX_BYTES) || 262144, 1048576)
function readBoundedFile(file, limit) {
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) return
  const descriptor = openSync(file, 'r')
  try {
    const current = fstatSync(descriptor)
    if (!current.isFile() || current.size > limit) return
    const buffer = Buffer.alloc(current.size)
    let offset = 0
    while (offset < buffer.length) {
      const length = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (!length) break
      offset += length
    }
    if (fstatSync(descriptor).size !== current.size) return
    return buffer.subarray(0, offset)
  } finally {
    closeSync(descriptor)
  }
}
const secretValues = new Set()
for (const [key, value] of Object.entries(process.env)) {
  if (
    value &&
    value.length >= 4 &&
    /key|token|secret|password|credential|authorization|cookie/i.test(key)
  )
    secretValues.add(value)
}
try {
  for (const name of readdirSync(process.cwd()).filter((name) =>
    /^\.env(?:\.[\w.-]+)?$/.test(name)
  )) {
    const file = resolve(process.cwd(), name)
    const bytes = readBoundedFile(file, 1048576)
    if (!bytes) continue
    const source = bytes.toString('utf8')
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?[\w]+\s*=\s*(.*?)\s*$/)
      if (!match) continue
      let value = match[1]
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1)
      else value = value.replace(/\s+#.*$/, '')
      if (value.length >= 3) secretValues.add(value)
    }
  }
} catch {
  /* Missing or unreadable .env files never change agent decisions. */
}
let custom = []
try {
  custom = JSON.parse(process.env.RIVALCODE_REDACTIONS || '[]').map(
    (pattern) => new RegExp(pattern, 'g')
  )
} catch {
  /* Main config validation rejects malformed regexes. */
}
const secretPatterns = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bBearer\s+[^\s,;"']+/gi,
  /\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s,;"']+/gi
]
function redact(value) {
  if (typeof value !== 'string') return value
  let result = value
  for (const secret of secretValues) result = result.split(secret).join('[REDACTED]')
  for (const pattern of [...secretPatterns, ...custom])
    result = result.replace(pattern, '[REDACTED]')
  return result
}
let sequence = 0
function observe(type, payload, nativeId) {
  if (!CAPTURE_PATH || !CAPTURE_SESSION) return
  try {
    const target = resolve(CAPTURE_PATH)
    if (!existsSync(dirname(target)) || (existsSync(target) && lstatSync(target).isSymbolicLink()))
      return
    const safe = {}
    for (const [key, value] of Object.entries(payload || {})) {
      if (
        [
          'tool',
          'toolId',
          'command',
          'path',
          'message',
          'permission',
          'sessionId',
          'model',
          'status',
          'contentHash'
        ].includes(key) &&
        typeof value === 'string'
      )
        safe[key] = redact(value)
      if (key === 'failed' && typeof value === 'boolean') safe[key] = value
      if (key === 'exitCode' && typeof value === 'number') safe[key] = value
    }
    const record = {
      rivalcode: 1,
      source: 'hook',
      type,
      timestamp: new Date().toISOString(),
      nativeId: redact(nativeId || 'observer-' + CAPTURE_SESSION + '-' + ++sequence),
      payload: safe
    }
    let output = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(output) > MAX_EVENT_BYTES)
      output =
        JSON.stringify({
          ...record,
          payload: { message: 'Integration event exceeded capture limit' }
        }) + '\n'
    const current = existsSync(target) ? statSync(target).size : 0
    if (current + Buffer.byteLength(output) > MAX_BYTES) return
    appendFileSync(target, output, { encoding: 'utf8', mode: 0o600, flag: 'a' })
  } catch {
    /* Observational capture must never deny or alter a tool call. */
  }
}
function hookTool(phase, input, error) {
  const name = input.tool_name || input.tool || 'unknown'
  const args = input.tool_input || input.args || {}
  const command =
    /^(bash|shell|run_shell_command|shell_command|execute|exec_command)$/i.test(name) &&
    typeof (args.command || args.cmd) === 'string'
      ? args.command || args.cmd
      : undefined
  const toolId = input.tool_use_id || input.callID || input.callId
  observe(
    command ? 'command_' + phase : 'tool_' + phase,
    {
      tool: name,
      toolId,
      command,
      path: args.file_path || args.filePath || args.path,
      ...(phase === 'finished' ? { failed: Boolean(error) } : {})
    },
    toolId ? toolId + ':' + phase : undefined
  )
}
function observeFile(file) {
  if (typeof file !== 'string') return
  const payload = { path: file }
  try {
    const root = realpathSync(process.env.RIVALCODE_PROJECT_ROOT || process.cwd())
    const target = resolve(root, file)
    const scoped = relative(root, target)
    if (scoped === '..' || scoped.startsWith('..' + sep) || isAbsolute(scoped)) return
    if (
      scoped
        .split(/[\\/]/)
        .some((part) => /^(?:\.git|\.rivalcode|\.opencode|node_modules|\.env(?:\..*)?)$/.test(part))
    )
      return
    const info = lstatSync(target)
    const actual = relative(root, realpathSync(target))
    if (
      actual === '..' ||
      actual.startsWith('..' + sep) ||
      isAbsolute(actual) ||
      info.isSymbolicLink() ||
      !info.isFile()
    )
      return
    payload.path = scoped.replaceAll('\\', '/')
    payload.status = 'M'
    // Hash only a bounded regular file; content never enters the event or capture file.
    const bytes = readBoundedFile(target, 1048576)
    if (bytes) payload.contentHash = createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    if (error.code !== 'ENOENT') return
  }
  observe('file_changed', payload)
}
`

/** Claude/Gemini stdin hook runner. Exit zero with no agent-facing additions or decisions. */
export const hookCollectorScript =
  collectorSource +
  String.raw`let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (input.length < 1048576) input += chunk
})
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input)
    switch (data.hook_event_name) {
      case 'PreToolUse':
      case 'BeforeTool':
        hookTool('started', data, false)
        break
      case 'PostToolUse':
      case 'AfterTool':
        hookTool('finished', data, Boolean(data.tool_response?.error))
        break
      case 'PostToolUseFailure':
        hookTool('finished', data, true)
        break
      case 'SessionStart':
        observe('session_started', { sessionId: data.session_id })
        break
      case 'SessionEnd':
        observe('session_finished', { sessionId: data.session_id })
        break
      case 'Notification':
        if (data.notification_type === 'ToolPermission')
          observe('permission_requested', { permission: 'requested', tool: data.tool_name })
        break
    }
  } catch {
    observe('error', { message: 'Integration hook received malformed JSON' })
  }
  process.stdout.write('{}\n')
})
`
