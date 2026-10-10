import { createHash, randomUUID } from 'node:crypto'
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
const mixedModelCostSource = 'Cost unavailable: mixed-model usage lacks complete native accounting'
const incompleteTokenCostSource = 'Cost unavailable: incomplete token accounting lacks native cost'
const validTokens = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const generatedId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const semanticEnums: Record<string, readonly string[]> = {
  semantics: ['incremental', 'cumulative'],
  costType: ['provider_reported', 'estimated', 'unknown'],
  modelSource: ['configured', 'native'],
  modelScope: ['single', 'mixed', 'unknown'],
  tokenScope: ['session', 'main-agent', 'unknown'],
  scope: ['turn', 'step', 'session'],
  severity: ['info', 'warning', 'error'],
  phase: ['setup', 'baseline', 'final'],
  status: [
    'preparing',
    'running',
    'verifying',
    'completed',
    'failed',
    'aborted',
    'A',
    'D',
    'M',
    'R',
    'C',
    'add',
    'delete',
    'update',
    'modify',
    'rename'
  ],
  kind: ['add', 'delete', 'update', 'modify', 'rename']
}

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
    'modelSource',
    'modelScope',
    'tokenScope',
    'semantics',
    'scope',
    'source',
    'provenance',
    'costUsd',
    'costType'
  ],
  cost: ['costUsd', 'costType', 'semantics', 'source', 'provenance', 'model', 'modelSource'],
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
  if (!input || !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload))
    return null
  if (!Object.hasOwn(payloadFields, input.type)) return null
  const allowed = payloadFields[input.type]
  if (!allowed || !['native', 'hook', 'otel', 'process', 'git', 'rivalcode'].includes(input.source))
    return null
  if (input.type === 'assistant_output' && !config.privacy.storeAssistantOutput) return null
  if (input.type === 'task' && !config.privacy.storeTaskPrompt) return null

  const selected = Object.fromEntries(
    Object.entries(input.payload).filter(([key]) => allowed.includes(key))
  )
  if (input.payload.truncated === true) {
    selected.truncated = true
    selected.message = 'Event exceeded configured size limit.'
  }
  if (input.type === 'finding' && selected.evidence && typeof selected.evidence === 'object')
    selected.evidence = Object.fromEntries(
      Object.entries(selected.evidence).filter(([key]) =>
        ['eventIds', 'checkIds', 'paths'].includes(key)
      )
    )

  const payload = redact(applyPrivacy(selected, config)) as Record<string, unknown>
  for (const [key, values] of Object.entries(semanticEnums))
    if (typeof selected[key] === 'string' && values.includes(selected[key] as string))
      payload[key] = selected[key]

  if (input.source === 'rivalcode') {
    if (typeof selected.verificationId === 'string' && generatedId.test(selected.verificationId))
      payload.verificationId = selected.verificationId
    if (input.type === 'finding') {
      if (typeof selected.id === 'string' && generatedId.test(selected.id)) payload.id = selected.id
      const original = selected.evidence as Record<string, unknown> | undefined
      const evidence = payload.evidence as Record<string, unknown> | undefined
      if (original && evidence) {
        for (const key of ['eventIds', 'checkIds'])
          if (Array.isArray(original[key]))
            evidence[key] = (original[key] as unknown[]).filter(
              (id) => typeof id === 'string' && generatedId.test(id)
            )
      }
    }
  }

  const time = input.timestamp ? new Date(input.timestamp) : new Date()
  const timestamp = Number.isFinite(time.getTime()) ? time.toISOString() : new Date().toISOString()
  const nativeId = input.nativeId ? String(redact(input.nativeId)) : undefined
  const base = {
    id: randomUUID(),
    sessionId,
    agentId,
    timestamp,
    type: input.type,
    source: input.source,
    ...(nativeId
      ? {
          nativeId:
            Buffer.byteLength(nativeId) > 512
              ? 'sha256:' + createHash('sha256').update(nativeId).digest('hex')
              : nativeId
        }
      : {})
  }

  if (Buffer.byteLength(JSON.stringify({ ...base, payload })) > config.limits.maxEventBytes)
    return {
      ...base,
      payload: {
        truncated: true,
        message: 'Event exceeded configured size limit.',
        ...Object.fromEntries(
          Object.entries(payload).filter(([key, value]) =>
            ['fatal', 'failed', 'timedOut', 'aborted', 'success'].includes(key)
              ? typeof value === 'boolean'
              : [
                    'severity',
                    'status',
                    'semantics',
                    'costType',
                    'modelSource',
                    'modelScope',
                    'tokenScope',
                    'scope'
                  ].includes(key)
                ? typeof value === 'string' && semanticEnums[key]?.includes(value)
                : [
                    'exitCode',
                    'inputTokens',
                    'outputTokens',
                    'cachedInputTokens',
                    'totalTokens',
                    'costUsd'
                  ].includes(key) &&
                  typeof value === 'number' &&
                  Number.isFinite(value)
          )
        )
      }
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
  const localEstimateBefore = previous.source?.startsWith(estimateSource) === true
  const modelChanged =
    typeof payload.model === 'string' &&
    previous.model !== undefined &&
    payload.model !== previous.model &&
    ((previous.inputTokens ?? 0) > 0 || (previous.outputTokens ?? 0) > 0)
  const mixedModelCost =
    previous.source === mixedModelCostSource ||
    (payload.modelScope === 'mixed' && (localEstimateBefore || previous.costUsd === undefined)) ||
    (modelChanged && (localEstimateBefore || previous.costUsd === undefined))
  let tokenCountsChanged = false
  let addedInput = 0
  let addedOutput = 0

  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens'] as const) {
    const value = payload[key]
    if (!validTokens(value)) continue
    if (
      key === 'cachedInputTokens' &&
      validTokens(payload.inputTokens) &&
      value > payload.inputTokens
    )
      continue

    const total = cumulative ? value : (previous[key] ?? 0) + value
    if (!validTokens(total)) continue
    next[key] = total

    if (key === 'inputTokens' || key === 'outputTokens') {
      tokenCountsChanged = true
      if (key === 'inputTokens') addedInput = value
      else addedOutput = value
    }
  }
  if (next.inputTokens !== undefined && (next.cachedInputTokens ?? 0) > next.inputTokens)
    delete next.cachedInputTokens

  if (typeof payload.model === 'string') {
    next.model = payload.model
    next.modelSource = payload.modelSource === 'configured' ? 'configured' : 'native'
  }

  if (
    typeof payload.tokenScope === 'string' &&
    semanticEnums.tokenScope!.includes(payload.tokenScope)
  )
    next.tokenScope = payload.tokenScope as NonNullable<UsageRecord['tokenScope']>

  const incompleteTokens = next.tokenScope === 'main-agent' || next.tokenScope === 'unknown'
  if (incompleteTokens && (next.costUsd === undefined || localEstimateBefore)) {
    delete next.costUsd
    next.costType = 'unknown'
    next.source = incompleteTokenCostSource
  } else if (!incompleteTokens && next.source === incompleteTokenCostSource) {
    delete next.source
  }

  // Aggregate token totals cannot be repriced with the last model after a model switch.
  if (mixedModelCost) {
    delete next.costUsd
    next.costType = 'unknown'
    next.source = mixedModelCostSource
  }

  const incomingCost =
    typeof payload.costUsd === 'number' && Number.isFinite(payload.costUsd) && payload.costUsd >= 0
  if (incomingCost && (!mixedModelCost || cumulative)) {
    // Native accounting replaces a local price estimate rather than adding to it.
    const baseCost = localEstimateBefore ? 0 : (previous.costUsd ?? 0)
    const cost = cumulative ? (payload.costUsd as number) : baseCost + (payload.costUsd as number)
    if (Number.isFinite(cost)) {
      next.costUsd = cost
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
  }

  if (
    tokenCountsChanged &&
    next.inputTokens !== undefined &&
    next.outputTokens !== undefined &&
    !validTokens(payload.totalTokens)
  ) {
    const total =
      !cumulative && previous.totalTokens !== undefined
        ? previous.totalTokens + addedInput + addedOutput
        : next.inputTokens + next.outputTokens
    if (validTokens(total)) next.totalTokens = total
    else delete next.totalTokens
  }

  const price = next.model ? config.pricing[next.model] : undefined
  const localEstimate = next.costUsd === undefined || localEstimateBefore
  if (
    !incomingCost &&
    !mixedModelCost &&
    !incompleteTokens &&
    localEstimate &&
    price &&
    next.inputTokens !== undefined &&
    next.outputTokens !== undefined
  ) {
    const cached = Math.min(next.cachedInputTokens ?? 0, next.inputTokens)
    const cost =
      ((next.inputTokens - cached) / 1000000) * price.inputPerMillion +
      (cached / 1000000) * (price.cachedInputPerMillion ?? price.inputPerMillion) +
      (next.outputTokens / 1000000) * price.outputPerMillion
    if (Number.isFinite(cost)) {
      next.costUsd = cost
      next.costType = 'estimated'
      next.source =
        estimateSource + (next.modelSource === 'configured' ? ' (configured model)' : '')
    }
  }

  return next
}
