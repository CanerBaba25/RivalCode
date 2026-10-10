import type { EventInput, EventType, UsageRecord } from '@rivalcode/shared'

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

/** Aggregate headers do not prove which models contributed to the reported totals. */
export function modelUsageScope(
  value: unknown,
  tokenKeys: readonly string[]
): Pick<UsageRecord, 'modelScope' | 'model'> {
  let active = 0
  let ambiguous = false
  let activeModel: string | undefined

  for (const [model, entry] of Object.entries(object(value))) {
    const counts = tokenKeys.map((key) => object(entry)[key])
    const complete = counts
      .slice(0, 2)
      .every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
    const valid = counts.every(
      (count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0)
    )
    if (!model || !complete || !valid) ambiguous = true

    if (
      model &&
      (counts.some((count) => typeof count === 'number' && Number.isFinite(count) && count > 0) ||
        (number(object(entry).costUSD) ?? 0) > 0)
    ) {
      activeModel = model
      if (++active === 2) return { modelScope: 'mixed' }
    }
  }

  return active === 1 && !ambiguous
    ? { modelScope: 'single', model: activeModel }
    : { modelScope: 'unknown' }
}

/** Claude's result.usage excludes subagents; only a complete modelUsage map covers the tree. */
export function aggregateClaudeUsage(
  value: unknown,
  mainAgentUsage: unknown
):
  | Pick<UsageRecord, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'totalTokens'>
  | undefined {
  const entries = Object.entries(object(value))
  if (entries.length === 0) return undefined

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  }
  const keys = Object.keys(totals) as (keyof typeof totals)[]

  for (const [model, entry] of entries) {
    if (!model.trim()) return undefined
    const counts = object(entry)

    for (const key of keys) {
      const count = counts[key]
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined

      const sum = totals[key] + count
      if (!Number.isSafeInteger(sum)) return undefined
      totals[key] = sum
    }
  }

  // A purported whole-tree map cannot account for less than the known main-agent counters.
  const main = object(mainAgentUsage)
  const mainKeys = {
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    cacheReadInputTokens: 'cache_read_input_tokens',
    cacheCreationInputTokens: 'cache_creation_input_tokens'
  }

  for (const key of keys) {
    const count = main[mainKeys[key]]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count > totals[key])
      return undefined
  }

  const inputTokens =
    totals.inputTokens + totals.cacheReadInputTokens + totals.cacheCreationInputTokens
  // outputTokens already includes thinkingTokens in the official modelUsage contract.
  const totalTokens = inputTokens + totals.outputTokens
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(totalTokens)) return undefined

  return {
    inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cacheReadInputTokens,
    totalTokens
  }
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
    model: text(payload.model),
    modelScope: ['single', 'mixed', 'unknown'].includes(String(payload.modelScope ?? ''))
      ? text(payload.modelScope)
      : undefined,
    tokenScope: ['session', 'main-agent', 'unknown'].includes(String(payload.tokenScope ?? ''))
      ? text(payload.tokenScope)
      : undefined
  })
  return [event(raw.type as EventType, safe, raw, text(raw.nativeId), 'hook')]
}
