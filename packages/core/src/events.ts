import { randomUUID } from 'node:crypto'
import type {
  NormalizedEvent,
  EventInput,
  AgentId,
  RivalConfig,
  UsageRecord,
  EventType
} from '@rivalcode/shared'

const forbiddenKeys =
  /^(reasoning|thinking|analysis|chain_of_thought|thoughts|raw|rawEvent|credentials|authorization|cookie|apiKey|api_key)$/i
const outputKeys =
  /^(output|stdout|stderr|aggregated_output|toolOutput|tool_response|response|result|content|input|parameters|arguments)$/i
const estimateSource = 'Estimated API-equivalent cost from configured pricing'
const validTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const payloadFields: Record<EventType, string[]> = {
  session_started: ['demo', 'baseCommit', 'providerSessionId', 'sessionId', 'model'],
  session_finished: [
    'exitCode',
    'durationMs',
    'timedOut',
    'aborted',
    'status',
    'error',
    'failed',
    'fatal',
    'providerSessionId',
    'sessionId'
  ],
  task: ['text'],
  assistant_output: ['text', 'delta', 'model', 'demo'],
  tool_started: ['tool', 'toolId', 'path', 'server', 'command', 'demo'],
  tool_finished: [
    'tool',
    'toolId',
    'path',
    'server',
    'command',
    'failed',
    'success',
    'exitCode',
    'output',
    'error',
    'durationMs',
    'demo'
  ],
  command_started: ['command', 'tool', 'toolId', 'path', 'demo'],
  command_finished: [
    'command',
    'tool',
    'toolId',
    'path',
    'exitCode',
    'failed',
    'success',
    'output',
    'error',
    'durationMs',
    'demo'
  ],
  file_changed: [
    'path',
    'oldPath',
    'kind',
    'status',
    'additions',
    'deletions',
    'binary',
    'observation',
    'contentHash',
    'demo'
  ],
  permission_requested: ['permission', 'tool', 'toolId', 'sessionId'],
  permission_resolved: ['permission', 'tool', 'toolId', 'sessionId'],
  usage: [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'totalTokens',
    'model',
    'semantics',
    'scope',
    'source',
    'provenance',
    'costUsd',
    'costType'
  ],
  cost: ['costUsd', 'costType', 'semantics', 'source', 'provenance', 'model'],
  error: [
    'message',
    'error',
    'category',
    'severity',
    'stage',
    'subtype',
    'toolId',
    'capture',
    'demo',
    'fatal'
  ],
  verification_started: ['verificationId', 'checkId', 'phase', 'command', 'required'],
  verification_finished: [
    'verificationId',
    'checkId',
    'phase',
    'required',
    'passed',
    'exitCode',
    'durationMs',
    'timedOut',
    'aborted',
    'truncated'
  ],
  finding: ['id', 'type', 'severity', 'title', 'detail', 'evidence']
}

export function applyPrivacy(value: unknown, config: RivalConfig): unknown {
  const ancestors = new WeakSet<object>()

  const visit = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol')
        return undefined
      if (typeof item === 'number' && !Number.isFinite(item)) return undefined
      return item
    }
    if (depth > 64 || ancestors.has(item)) return '[omitted recursive payload]'
    ancestors.add(item)
    const result: unknown = Array.isArray(item)
      ? item.map((entry) => visit(entry, depth + 1))
      : Object.fromEntries(
          Object.entries(item)
            .filter(
              ([key]) =>
                !forbiddenKeys.test(key) &&
                (config.privacy.storeToolOutput || !outputKeys.test(key))
            )
            .map(([key, entry]) => [key, visit(entry, depth + 1)])
        )
    ancestors.delete(item)
    return result
  }

  return visit(value, 0)
}

export function makeEvent(
  input: EventInput,
  sessionId: string,
  agentId: AgentId,
  config: RivalConfig,
  redact: (value: unknown) => unknown
): NormalizedEvent | null {
  const allowed = payloadFields[input.type]
  if (!allowed || !['native', 'hook', 'otel', 'process', 'git', 'rivalcode'].includes(input.source))
    return null
  if (input.type === 'assistant_output' && !config.privacy.storeAssistantOutput) return null
  if (input.type === 'task' && !config.privacy.storeTaskPrompt) return null

  const selected = Object.fromEntries(
    Object.entries(input.payload).filter(([key]) => allowed.includes(key))
  )
  if (input.type === 'finding' && selected.evidence && typeof selected.evidence === 'object')
    selected.evidence = Object.fromEntries(
      Object.entries(selected.evidence).filter(([key]) =>
        ['eventIds', 'checkIds', 'paths'].includes(key)
      )
    )

  const payload = redact(applyPrivacy(selected, config)) as Record<string, unknown>
  const time = input.timestamp ? new Date(input.timestamp) : new Date()
  const timestamp = Number.isFinite(time.getTime()) ? time.toISOString() : new Date().toISOString()
  const base = {
    id: randomUUID(),
    sessionId,
    agentId,
    timestamp,
    type: input.type,
    source: input.source,
    ...(input.nativeId ? { nativeId: String(redact(input.nativeId)) } : {})
  }

  if (Buffer.byteLength(JSON.stringify(payload)) > config.limits.maxEventBytes)
    return {
      ...base,
      payload: { truncated: true, message: 'Event exceeded configured size limit.' }
    }

  return { ...base, payload }
}

export function mergeUsage(
  previous: UsageRecord,
  payload: Record<string, unknown>,
  config: RivalConfig
): UsageRecord {
  const next = { ...previous }
  const cumulative = payload.semantics === 'cumulative'

  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens'] as const) {
    const value = payload[key]
    if (validTokens(value)) next[key] = cumulative ? value : (previous[key] ?? 0) + value
  }
  if (typeof payload.model === 'string') next.model = payload.model

  const incomingCost =
    typeof payload.costUsd === 'number' && Number.isFinite(payload.costUsd) && payload.costUsd >= 0
  if (incomingCost) {
    // Native accounting replaces a local price estimate rather than adding to it.
    const baseCost = previous.source === estimateSource ? 0 : (previous.costUsd ?? 0)
    next.costUsd = cumulative ? (payload.costUsd as number) : baseCost + (payload.costUsd as number)
    next.costType =
      payload.costType === 'provider_reported'
        ? 'provider_reported'
        : payload.costType === 'estimated'
          ? 'estimated'
          : 'unknown'
    next.source = String(
      payload.provenance ??
        payload.source ??
        'Native agent telemetry; billing provenance unspecified'
    )
  }

  const tokenCountsChanged = ['inputTokens', 'outputTokens'].some((key) =>
    validTokens(payload[key])
  )
  if (
    tokenCountsChanged &&
    next.inputTokens !== undefined &&
    next.outputTokens !== undefined &&
    payload.totalTokens === undefined
  ) {
    next.totalTokens =
      !cumulative && previous.totalTokens !== undefined
        ? previous.totalTokens +
          (validTokens(payload.inputTokens) ? payload.inputTokens : 0) +
          (validTokens(payload.outputTokens) ? payload.outputTokens : 0)
        : next.inputTokens + next.outputTokens
  }

  const price = next.model ? config.pricing[next.model] : undefined
  const localEstimate = next.costUsd === undefined || previous.source === estimateSource
  if (
    !incomingCost &&
    localEstimate &&
    price &&
    next.inputTokens !== undefined &&
    next.outputTokens !== undefined
  ) {
    const cached = Math.min(next.cachedInputTokens ?? 0, next.inputTokens)
    next.costUsd =
      ((next.inputTokens - cached) * price.inputPerMillion +
        cached * (price.cachedInputPerMillion ?? price.inputPerMillion) +
        next.outputTokens * price.outputPerMillion) /
      1000000
    next.costType = 'estimated'
    next.source = estimateSource
  }

  return next
}
