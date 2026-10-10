import type { EventInput, EventType } from '@rivalcode/shared'

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
export function fields(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}
export function toolInput(input: unknown): Record<string, unknown> {
  const args = object(input)

  return fields({
    command: text(args.command),
    cmd: text(args.cmd),
    file_path: text(args.file_path),
    filePath: text(args.filePath),
    path: text(args.path)
  })
}
export function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const time = new Date(value)
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined
}
export function event(
  type: EventType,
  payload: Record<string, unknown>,
  raw: Record<string, unknown>,
  nativeId?: string,
  source: EventInput['source'] = 'native'
): EventInput {
  return {
    type,
    source,
    payload: fields(payload),
    ...(timestamp(raw.timestamp) ? { timestamp: timestamp(raw.timestamp) } : {}),
    ...(nativeId ? { nativeId } : {})
  }
}
export function errorMessage(value: unknown): string | undefined {
  return text(value) ?? text(object(value).message)
}
export function usage(
  inputTokens?: number,
  outputTokens?: number,
  cachedInputTokens?: number,
  totalTokens?: number
): Record<string, unknown> {
  return fields({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens:
      totalTokens ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined)
  })
}
export function toolEvents(
  raw: Record<string, unknown>,
  phase: 'started' | 'finished',
  name: string | undefined,
  input: unknown,
  id?: string,
  failed = false,
  output?: unknown
): EventInput[] {
  const args = object(input)
  const isCommand =
    name !== undefined &&
    /^(bash|shell|run_shell_command|shell_command|execute|exec_command)$/i.test(name)
  const command = isCommand ? (text(args.command) ?? text(args.cmd)) : undefined
  // Arguments can contain prompts or credentials. Retain only observable paths and commands.
  const path = text(args.file_path) ?? text(args.filePath) ?? text(args.path)
  const result: EventInput[] = [
    event(
      isCommand ? `command_${phase}` : `tool_${phase}`,
      {
        tool: name ?? 'unknown',
        command,
        path,
        toolId: id,
        ...(phase === 'finished' ? { failed, ...(output !== undefined ? { output } : {}) } : {})
      },
      raw,
      id ? `${id}:${phase}` : undefined
    )
  ]
  if (
    phase === 'finished' &&
    !failed &&
    path &&
    /^(write|edit|write_file|replace|apply_patch|str_replace_editor|multiedit)$/i.test(name ?? '')
  )
    result.push(event('file_changed', { path, tool: name }, raw, id ? `${id}:file` : undefined))
  return result
}
export function captureEvent(raw: Record<string, unknown>): EventInput[] | null {
  if (raw.type === 'rivalcode.capture_error')
    return [
      event(
        'error',
        { message: text(raw.message) ?? 'Integration capture failed', capture: true },
        raw,
        undefined,
        'process'
      )
    ]
  if (raw.rivalcode !== 1 || raw.source !== 'hook') return null
  const allowed = new Set<EventType>([
    'tool_started',
    'tool_finished',
    'command_started',
    'command_finished',
    'file_changed',
    'permission_requested',
    'permission_resolved',
    'session_started',
    'session_finished',
    'error',
    'usage'
  ])
  if (!allowed.has(raw.type as EventType)) return []
  const payload = object(raw.payload)
  // Never trust a local hook file to bypass the storage allowlist.
  const safe = fields({
    tool: text(payload.tool),
    toolId: text(payload.toolId),
    command: text(payload.command),
    path: text(payload.path),
    status: text(payload.status),
    contentHash: /^[a-f0-9]{64}$/.test(String(payload.contentHash ?? ''))
      ? text(payload.contentHash)
      : undefined,
    failed: typeof payload.failed === 'boolean' ? payload.failed : undefined,
    exitCode: number(payload.exitCode),
    message: text(payload.message),
    permission: text(payload.permission),
    sessionId: text(payload.sessionId),
    model: text(payload.model)
  })
  return [event(raw.type as EventType, safe, raw, text(raw.nativeId), 'hook')]
}
