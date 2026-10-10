import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  EventInput,
  PreparedRun,
  RunContext
} from '@rivalcode/shared'
import { detectAgent } from './detection.js'
import {
  captureEvent,
  errorMessage,
  event,
  fields,
  list,
  number,
  object,
  text,
  toolEvents,
  toolInput,
  usage
} from './normalize.js'
import { prepareOpenCodePlugin, uninstallHooks } from '../../../integrations/opencode.js'
import { demoScript } from './demo.js'

export { JsonlParser } from './jsonl.js'
export { uninstallHooks }

const capabilities = (overrides: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  structuredEvents: true,
  toolEvents: true,
  commandEvents: true,
  tokenUsage: true,
  providerCost: false,
  modelIdentity: true,
  interactiveMode: true,
  ...overrides
})
const toolKey = (id: string) => createHash('sha256').update(id).digest('hex')

function rememberTool(
  pending: Map<string, { name?: string; input: unknown }>,
  id: string,
  name: string | undefined,
  input: unknown
) {
  pending.set(toolKey(id), { name, input: toolInput(input) })

  // Completed calls are removed immediately; cap unfinished metadata from malformed streams.
  if (pending.size > 128) pending.delete(pending.keys().next().value!)
}

abstract class NativeAdapter implements AgentAdapter {
  abstract id: AgentId
  abstract displayName: string
  abstract executable: string
  capabilities = capabilities()
  private captured = new Set<string>()

  detect() {
    return detectAgent(this.id, this.displayName, this.executable, this.capabilities)
  }

  abstract prepareRun(ctx: RunContext): Promise<PreparedRun>
  abstract parseNative(raw: Record<string, unknown>): EventInput[]

  parseEvent(raw: unknown): EventInput[] {
    const record = object(raw)
    if (
      /reasoning|thinking|analysis/i.test(String(record.type ?? '')) ||
      /reasoning|thinking|analysis/i.test(String(object(record.item).type ?? '')) ||
      record.thought === true ||
      record.thinking === true ||
      record.channel === 'analysis' ||
      record.channel === 'reasoning' ||
      record.role === 'analysis'
    )
      return []

    const events = captureEvent(record) ?? this.parseNative(record)
    return events.filter((item) => {
      if (item.nativeId === undefined) return true
      const key = `${item.type}:${toolKey(item.nativeId)}`
      if (this.captured.has(key)) return false
      this.captured.add(key)
      // Cap state for extremely long sessions. Session event persistence remains bounded separately.
      if (this.captured.size > 100000) this.captured.delete(this.captured.values().next().value!)
      return true
    })
  }

  protected extras(ctx: RunContext): string[] {
    if (ctx.config.battle.network === 'deny')
      throw new Error(
        `${this.displayName} cannot guarantee network isolation through a local CLI. Use an externally isolated runner or network=inherit.`
      )
    const args = ctx.config.agents[this.id]?.args ?? []
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
      throw new Error('Agent arguments must be literal strings without NUL bytes')
    return args
  }
}

export class CodexAdapter extends NativeAdapter {
  id = 'codex' as const
  displayName = 'Codex'
  executable = 'codex'
  capabilities = capabilities({ modelIdentity: false })

  async prepareRun(ctx: RunContext): Promise<PreparedRun> {
    const extras = this.extras(ctx)
    return {
      executable: this.executable,
      args: [
        '-a',
        'never',
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '--ephemeral',
        '--color',
        'never',
        '--cd',
        ctx.cwd,
        ...(ctx.model ? ['--model', ctx.model] : []),
        ...extras,
        '-'
      ],
      stdin: `${ctx.task}\n`
    }
  }

  parseNative(raw: Record<string, unknown>): EventInput[] {
    const type = text(raw.type)
    if (type === 'thread.started')
      return [
        event(
          'session_started',
          { providerSessionId: text(raw.thread_id) },
          raw,
          text(raw.thread_id)
        )
      ]
    if (type === 'turn.completed') {
      const value = object(raw.usage)
      return [
        event(
          'usage',
          {
            ...usage(
              number(value.input_tokens),
              number(value.output_tokens),
              number(value.cached_input_tokens)
            ),
            semantics: 'incremental',
            scope: 'turn'
          },
          raw
        )
      ]
    }
    if (type === 'error' || type === 'turn.failed')
      return [
        event(
          'error',
          {
            message: errorMessage(raw.error) ?? text(raw.message) ?? 'Codex turn failed',
            ...(type === 'turn.failed' ? { fatal: true } : {})
          },
          raw
        )
      ]
    if (!type?.startsWith('item.')) return []
    const item = object(raw.item)
    const id = text(item.id)
    if (item.type === 'error')
      return [event('error', { message: text(item.message) ?? 'Codex item failed' }, raw, id)]
    if (item.type === 'agent_message' && type === 'item.completed')
      return [event('assistant_output', { text: text(item.text) }, raw, id)]
    if (
      item.type === 'command_execution' &&
      (type === 'item.started' || type === 'item.completed')
    ) {
      const phase = type === 'item.started' ? 'started' : 'finished'
      return [
        event(
          `command_${phase}`,
          {
            command: text(item.command),
            tool: 'shell',
            toolId: id,
            ...(phase === 'finished'
              ? {
                  exitCode: number(item.exit_code),
                  failed:
                    item.status === 'failed' ||
                    (typeof item.exit_code === 'number' && item.exit_code !== 0),
                  output: text(item.aggregated_output)
                }
              : {})
          },
          raw,
          id ? `${id}:${phase}` : undefined
        )
      ]
    }
    if (item.type === 'mcp_tool_call' && (type === 'item.started' || type === 'item.completed')) {
      const phase = type === 'item.started' ? 'started' : 'finished'
      return [
        event(
          `tool_${phase}`,
          {
            tool: text(item.tool),
            server: text(item.server),
            toolId: id,
            ...(phase === 'finished'
              ? {
                  failed: item.status === 'failed' || item.error != null,
                  error: errorMessage(item.error)
                }
              : {})
          },
          raw,
          id ? `${id}:${phase}` : undefined
        )
      ]
    }
    if (item.type === 'file_change' && type === 'item.completed')
      return list(item.changes).flatMap((change, index) => {
        const value = object(change)
        const path = text(value.path)
        return path
          ? [
              event(
                'file_changed',
                { path, kind: text(value.kind) },
                raw,
                id ? `${id}:${index}` : undefined
              )
            ]
          : []
      })
    if (item.type === 'web_search' && (type === 'item.started' || type === 'item.completed'))
      return [
        event(
          type === 'item.started' ? 'tool_started' : 'tool_finished',
          { tool: 'web_search' },
          raw,
          id ? `${id}:${type}` : undefined
        )
      ]
    return []
  }
}

export class ClaudeAdapter extends NativeAdapter {
  id = 'claude' as const
  displayName = 'Claude Code'
  executable = 'claude'
  private tools = new Map<string, { name?: string; input: unknown }>()
  private visible = false
  private model?: string
  async prepareRun(ctx: RunContext): Promise<PreparedRun> {
    return {
      executable: this.executable,
      args: [
        '-p',
        ctx.task,
        '--output-format',
        'stream-json',
        '--verbose',
        ...(ctx.model ? ['--model', ctx.model] : []),
        ...this.extras(ctx)
      ]
    }
  }
  parseNative(raw: Record<string, unknown>): EventInput[] {
    if (raw.type === 'system' && raw.subtype === 'init') {
      this.model = text(raw.model)
      const result = [
        event(
          'session_started',
          { providerSessionId: text(raw.session_id), model: this.model },
          raw,
          text(raw.uuid)
        )
      ]
      for (const error of [...list(raw.plugin_errors), ...list(raw.mcp_server_errors)])
        result.push(
          event(
            'error',
            {
              message: errorMessage(error) ?? 'A configured Claude integration failed to load',
              stage: 'startup'
            },
            raw
          )
        )
      return result
    }
    if (raw.type === 'system' && raw.subtype === 'permission_denied')
      return [
        event(
          'permission_resolved',
          { permission: 'denied', tool: text(raw.tool_name), toolId: text(raw.tool_use_id) },
          raw,
          text(raw.uuid)
        )
      ]
    if (
      raw.type === 'system' &&
      (raw.subtype === 'api_retry' || raw.subtype === 'error' || raw.subtype === 'warning')
    )
      return [
        event(
          'error',
          {
            message:
              errorMessage(raw.error) ?? text(raw.message) ?? `Claude ${String(raw.subtype)}`,
            severity: raw.subtype === 'error' ? 'error' : 'warning',
            subtype: text(raw.subtype)
          },
          raw,
          text(raw.uuid)
        )
      ]
    if (raw.type === 'assistant') {
      const message = object(raw.message)
      return list(message.content).flatMap((block, index) => {
        const value = object(block)
        const id = text(value.id) ?? `${text(message.id) ?? text(raw.uuid) ?? 'assistant'}:${index}`
        if (value.type === 'text' && text(value.text)) {
          this.visible = true
          return [
            event(
              'assistant_output',
              { text: text(value.text), model: text(message.model) },
              raw,
              id
            )
          ]
        }
        if (value.type === 'tool_use') {
          const name = text(value.name)
          rememberTool(this.tools, id, name, value.input)
          return toolEvents(raw, 'started', name, value.input, id)
        }
        return []
      })
    }
    if (raw.type === 'user')
      return list(object(raw.message).content).flatMap((block) => {
        const value = object(block)
        if (value.type !== 'tool_result') return []
        const id = text(value.tool_use_id)
        const previous = id ? this.tools.get(toolKey(id)) : undefined
        if (id) this.tools.delete(toolKey(id))
        const output =
          typeof value.content === 'string'
            ? value.content
            : list(value.content)
                .filter((part) => object(part).type === 'text')
                .map((part) => text(object(part).text) ?? '')
                .join('\n')
        return toolEvents(
          raw,
          'finished',
          previous?.name,
          previous?.input,
          id,
          value.is_error === true,
          output
        )
      })
    if (raw.type === 'result') {
      this.tools.clear()
      const failed =
        raw.is_error === true ||
        (typeof raw.subtype === 'string' && raw.subtype.startsWith('error'))
      const value = object(raw.usage)
      const cached = number(value.cache_read_input_tokens)
      const creation = number(value.cache_creation_input_tokens)
      const baseInput = number(value.input_tokens)
      const input =
        baseInput === undefined ? undefined : baseInput + (cached ?? 0) + (creation ?? 0)
      const result: EventInput[] = [
        event(
          'usage',
          {
            ...usage(input, number(value.output_tokens), cached),
            model: this.model,
            semantics: 'cumulative',
            scope: 'session',
            source: 'claude_cli'
          },
          raw,
          text(raw.uuid) ? `${raw.uuid}:usage` : undefined
        )
      ]
      if (number(raw.total_cost_usd) !== undefined)
        result.push(
          event(
            'cost',
            {
              costUsd: number(raw.total_cost_usd),
              costType: 'estimated',
              semantics: 'cumulative',
              provenance: 'Claude CLI client estimate; not subscription billing'
            },
            raw,
            text(raw.uuid) ? `${raw.uuid}:cost` : undefined
          )
        )
      if (!this.visible && text(raw.result))
        result.push(
          event(
            'assistant_output',
            { text: text(raw.result) },
            raw,
            text(raw.uuid) ? `${raw.uuid}:result` : undefined
          )
        )
      if (failed)
        result.push(
          event(
            'error',
            {
              message:
                list(raw.errors).map(errorMessage).filter(Boolean).join('\n') ||
                'Claude run failed',
              subtype: text(raw.subtype),
              fatal: true
            },
            raw
          )
        )
      for (const denied of list(raw.permission_denials)) {
        const value = object(denied)
        result.push(
          event(
            'permission_resolved',
            { permission: 'denied', tool: text(value.tool_name), toolId: text(value.tool_use_id) },
            raw
          )
        )
      }
      result.push(
        event(
          'session_finished',
          { failed, ...(failed ? { fatal: true } : {}), providerSessionId: text(raw.session_id) },
          raw,
          text(raw.uuid) ? `${raw.uuid}:finished` : undefined
        )
      )
      return result
    }
    if (raw.type === 'stream_event') {
      // Partial-message capture is optional. Only visible text deltas are accepted.
      const value = object(raw.event)
      const delta = object(value.delta)
      if (value.type === 'content_block_delta' && delta.type === 'text_delta' && text(delta.text))
        return [
          event('assistant_output', { text: text(delta.text), delta: true }, raw, text(raw.uuid))
        ]
    }
    return []
  }
}

export class GeminiAdapter extends NativeAdapter {
  id = 'gemini' as const
  displayName = 'Gemini CLI'
  executable = 'gemini'
  private tools = new Map<string, { name?: string; input: unknown }>()
  private model?: string
  async prepareRun(ctx: RunContext): Promise<PreparedRun> {
    return {
      executable: this.executable,
      args: [
        '-p',
        ctx.task,
        '--output-format',
        'stream-json',
        ...(ctx.model ? ['--model', ctx.model] : []),
        ...this.extras(ctx)
      ]
    }
  }
  parseNative(raw: Record<string, unknown>): EventInput[] {
    if (raw.type === 'init') {
      this.model = text(raw.model)
      return [
        event(
          'session_started',
          { providerSessionId: text(raw.session_id), model: this.model },
          raw,
          text(raw.session_id)
        )
      ]
    }
    if (raw.type === 'message' && raw.role === 'assistant' && text(raw.content))
      return [
        event('assistant_output', { text: text(raw.content), delta: raw.delta === true }, raw)
      ]
    if (raw.type === 'tool_use') {
      const id = text(raw.tool_id)
      const name = text(raw.tool_name)
      if (id) rememberTool(this.tools, id, name, raw.parameters)
      return toolEvents(raw, 'started', name, raw.parameters, id)
    }
    if (raw.type === 'tool_result') {
      const id = text(raw.tool_id)
      const previous = id ? this.tools.get(toolKey(id)) : undefined
      if (id) this.tools.delete(toolKey(id))
      const result = toolEvents(
        raw,
        'finished',
        previous?.name,
        previous?.input,
        id,
        raw.status === 'error',
        text(raw.output)
      )
      if (raw.error)
        result.push(
          event(
            'error',
            { message: errorMessage(raw.error) ?? 'Gemini tool failed', toolId: id },
            raw
          )
        )
      return result
    }
    if (raw.type === 'error')
      return [
        event(
          'error',
          { message: text(raw.message) ?? 'Gemini error', severity: text(raw.severity) },
          raw
        )
      ]
    if (raw.type === 'result') {
      this.tools.clear()
      const stats = object(raw.stats)
      const result = [
        event(
          'usage',
          {
            ...usage(
              number(stats.input_tokens),
              number(stats.output_tokens),
              number(stats.cached),
              number(stats.total_tokens)
            ),
            model: this.model,
            semantics: 'cumulative',
            scope: 'session'
          },
          raw
        ),
        event(
          'session_finished',
          { failed: raw.status === 'error', ...(raw.status === 'error' ? { fatal: true } : {}) },
          raw
        )
      ]
      if (raw.status === 'error')
        result.push(
          event(
            'error',
            { message: errorMessage(raw.error) ?? 'Gemini run failed', fatal: true },
            raw
          )
        )
      return result
    }
    return []
  }
}

export class OpenCodeAdapter extends NativeAdapter {
  id = 'opencode' as const
  displayName = 'OpenCode'
  executable = 'opencode'
  capabilities = capabilities()
  async prepareRun(ctx: RunContext): Promise<PreparedRun> {
    const extras = this.extras(ctx)
    const integration = await prepareOpenCodePlugin(ctx)
    return {
      executable: this.executable,
      args: [
        'run',
        '--format',
        'json',
        ...(ctx.model ? ['--model', ctx.model] : []),
        ...extras,
        ctx.task
      ],
      ...integration
    }
  }
  parseNative(raw: Record<string, unknown>): EventInput[] {
    const part = object(raw.part)
    const id = text(part.callID) ?? text(part.id) ?? text(part.partID)
    if (raw.type === 'text')
      return text(part.text) ? [event('assistant_output', { text: text(part.text) }, raw, id)] : []
    if (raw.type === 'tool_use') {
      const state = object(part.state)
      return toolEvents(
        raw,
        'finished',
        text(part.tool),
        state.input,
        id,
        state.status === 'error',
        text(state.output)
      )
    }
    if (raw.type === 'step_finish') {
      const tokens = object(part.tokens)
      const cache = object(tokens.cache)
      const baseInput = number(tokens.input)
      const cached = number(cache.read)
      const cacheWrite = number(cache.write)
      const input =
        baseInput === undefined ? undefined : baseInput + (cached ?? 0) + (cacheWrite ?? 0)
      const visibleOutput = number(tokens.output)
      // OpenCode reports billable reasoning tokens separately from visible output.
      const output =
        visibleOutput === undefined ? undefined : visibleOutput + (number(tokens.reasoning) ?? 0)
      const result = [
        event(
          'usage',
          {
            ...usage(input, output, cached),
            model: text(part.modelID) ?? text(raw.model),
            semantics: 'incremental',
            scope: 'step'
          },
          raw,
          id ? `${id}:usage` : undefined
        )
      ]
      if (number(part.cost) !== undefined)
        result.push(
          event(
            'cost',
            {
              costUsd: number(part.cost),
              costType: 'estimated',
              semantics: 'incremental',
              provenance: 'OpenCode model token-price estimate; not an invoice'
            },
            raw,
            id ? `${id}:cost` : undefined
          )
        )
      return result
    }
    if (raw.type === 'error')
      return [
        event(
          'error',
          {
            message:
              errorMessage(raw.error) ??
              errorMessage(object(raw.error).data) ??
              text(raw.message) ??
              'OpenCode run failed',
            fatal: true
          },
          raw
        )
      ]
    return []
  }
}

export class DemoAdapter extends NativeAdapter {
  id = 'demo' as const
  displayName = 'Demo Agent'
  executable = process.execPath
  capabilities = capabilities({ tokenUsage: false, modelIdentity: false, interactiveMode: false })

  async detect() {
    return {
      id: this.id,
      displayName: this.displayName,
      installed: true,
      version: '1',
      auth: 'ready' as const,
      capabilities: this.capabilities,
      detail: 'Explicit deterministic demo; no provider model, tokens, or cost'
    }
  }

  async prepareRun(ctx: RunContext): Promise<PreparedRun> {
    if (!ctx.demo) throw new Error('Demo Agent requires the explicit --demo flag')
    this.extras(ctx)
    await mkdir(ctx.artifactDir, { recursive: true })
    const script = join(ctx.artifactDir, 'demo-agent.mjs')
    await writeFile(script, demoScript, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return { executable: process.execPath, args: [script], env: { RIVALCODE_DEMO_CWD: ctx.cwd } }
  }

  parseNative(raw: Record<string, unknown>): EventInput[] {
    if (raw.demo !== true) return []
    const allowed = new Set([
      'session_started',
      'session_finished',
      'command_started',
      'command_finished',
      'file_changed',
      'assistant_output',
      'error'
    ])
    if (!allowed.has(String(raw.type))) return []
    const payload = object(raw.payload)
    return [
      {
        type: raw.type as EventInput['type'],
        source: 'process',
        payload: fields({
          demo: true,
          text: text(payload.text),
          command: text(payload.command),
          path: text(payload.path),
          exitCode: number(payload.exitCode),
          message: text(payload.message),
          failed: typeof payload.failed === 'boolean' ? payload.failed : undefined
        }),
        nativeId: text(raw.id)
      }
    ]
  }
}

export function getAdapter(id: AgentId, demo = false): AgentAdapter {
  if (id === 'demo' && !demo) throw new Error('Demo Agent requires the explicit --demo flag')
  switch (id) {
    case 'codex':
      return new CodexAdapter()
    case 'claude':
      return new ClaudeAdapter()
    case 'gemini':
      return new GeminiAdapter()
    case 'opencode':
      return new OpenCodeAdapter()
    case 'demo':
      return new DemoAdapter()
    default:
      throw new Error(`Unsupported agent: ${String(id)}`)
  }
}

export async function detectAdapters(includeDemo = false) {
  const ids: AgentId[] = [
    'codex',
    'claude',
    'gemini',
    'opencode',
    ...(includeDemo ? ['demo' as const] : [])
  ]
  return Promise.all(ids.map((id) => getAdapter(id, includeDemo).detect()))
}
/** Compatibility name used by API adapter inventory. */
export const detectAgents = detectAdapters
