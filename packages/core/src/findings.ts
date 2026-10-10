import { randomUUID } from 'node:crypto'
import { minimatch } from 'minimatch'
import { resolveCommand, splitCommand } from '@rivalcode/runtime'
import type {
  Finding,
  NormalizedEvent,
  FileChange,
  VerificationRun,
  RivalConfig
} from '@rivalcode/shared'

export function detectFindings(
  events: NormalizedEvent[],
  files: FileChange[],
  verification: VerificationRun[],
  config: RivalConfig
): Finding[] {
  const findings: Finding[] = []
  const add = (
    type: string,
    severity: Finding['severity'],
    title: string,
    detail: string,
    evidence: Finding['evidence']
  ) => findings.push({ id: randomUUID(), type, severity, title, detail, evidence })
  const commands = new Map<string, NormalizedEvent[]>()
  for (const event of events.filter((e) => e.type === 'command_finished')) {
    const command = String(event.payload.command ?? '').trim()
    if (command) commands.set(command, [...(commands.get(command) ?? []), event])
  }
  for (const [command, observations] of commands) {
    const failed = observations.filter(
      (e) =>
        e.payload.failed === true ||
        e.payload.success === false ||
        (typeof e.payload.exitCode === 'number' && e.payload.exitCode !== 0)
    )
    if (observations.length >= 3)
      add('repeated_command', 'info', `Command repeated ${observations.length} times`, command, {
        eventIds: observations.map((e) => e.id)
      })
    if (failed.length >= 2)
      add('repeated_failure', 'warning', `Command failed ${failed.length} times`, command, {
        eventIds: failed.map((e) => e.id)
      })
  }
  for (const v of verification.filter((v) => v.phase === 'final' && v.required && !v.passed)) {
    add(
      'verification_failure',
      'error',
      `${v.checkId} required check failed`,
      `${v.command} exited ${v.exitCode ?? 'without an exit code'}.`,
      { checkIds: [v.id] }
    )
    if (verification.some((b) => b.phase === 'baseline' && b.checkId === v.checkId && b.passed))
      add(
        'regression',
        'error',
        `${v.checkId} regressed from baseline`,
        'The baseline passed and independent final verification failed.',
        { checkIds: verification.filter((b) => b.checkId === v.checkId).map((b) => b.id) }
      )
  }
  const forbidden = files.filter((f) =>
    config.forbiddenPaths.some(
      (p) =>
        minimatch(f.path, p, { dot: true }) || (f.oldPath && minimatch(f.oldPath, p, { dot: true }))
    )
  )
  if (forbidden.length)
    add(
      'forbidden_path',
      'error',
      'Forbidden paths changed',
      'These changes violate the configured benchmark boundaries.',
      { paths: forbidden.map((f) => f.path) }
    )
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0)
  if (files.length > config.scoring.maxFiles || lines > config.scoring.maxLines)
    add(
      'large_patch',
      'warning',
      'Patch exceeds configured thresholds',
      `${files.length} files / ${lines} changed lines; limits ${config.scoring.maxFiles} files / ${config.scoring.maxLines} lines.`,
      { paths: files.map((f) => f.path) }
    )
  const native = events.some((e) => e.source === 'native' || e.source === 'hook')
  const test = config.verification.commands.find((v) => v.id === 'test')
  if (
    native &&
    test &&
    !events.some(
      (e) =>
        (e.type === 'command_started' || e.type === 'command_finished') &&
        (e.source === 'native' || e.source === 'hook') &&
        observesCheck(String(e.payload.command ?? ''), test)
    )
  )
    add(
      'no_agent_verification',
      'info',
      'No agent test command observed',
      'The recorded native stream did not expose an attempt to run the configured test command. This is an observation, not proof of bad code.',
      { eventIds: events.filter((e) => e.type === 'session_finished').map((e) => e.id) }
    )
  const toolErrors = events.filter(
    (e) => e.type === 'tool_finished' && (e.payload.failed === true || e.payload.success === false)
  )
  if (toolErrors.length)
    add(
      'tool_errors',
      'warning',
      `${toolErrors.length} tool failures observed`,
      'Inspect the linked tool results.',
      { eventIds: toolErrors.map((e) => e.id) }
    )
  const edits = new Map<string, NormalizedEvent[]>()
  for (const e of events.filter(
    (e) => e.type === 'file_changed' && (e.source === 'native' || e.source === 'hook')
  )) {
    const path = String(e.payload.path ?? '').replaceAll('\\', '/')
    if (path) edits.set(path, [...(edits.get(path) ?? []), e])
  }
  for (const [path, changes] of edits) {
    const hashes = changes.map((e) => e.payload.contentHash).filter((v) => typeof v === 'string')
    const seen = new Set<string>()
    let previous: string | undefined
    const reverted = hashes.some((hash) => {
      if (hash === previous) return false
      const earlier = seen.has(hash)
      seen.add(hash)
      previous = hash
      return earlier
    })

    if (reverted)
      add(
        'high_churn',
        'warning',
        `Observed rewrite reverted: ${path}`,
        'Content-hash observations show this file returned to an earlier observed version.',
        { eventIds: changes.map((e) => e.id), paths: [path] }
      )
    if (
      /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum))$/.test(
        path
      ) &&
      changes.some(
        (event, index) =>
          ['add', 'A'].includes(String(event.payload.status ?? event.payload.kind)) &&
          changes
            .slice(index + 1)
            .some((later) =>
              ['delete', 'D'].includes(String(later.payload.status ?? later.payload.kind))
            )
      )
    )
      add(
        'dependency_churn',
        'warning',
        `Dependency file added then removed: ${path}`,
        'Recorded file events expose both operations.',
        { eventIds: changes.map((e) => e.id), paths: [path] }
      )
  }
  return findings
}

function observesCheck(
  command: string,
  spec: RivalConfig['verification']['commands'][number]
): boolean {
  try {
    const configured = resolveCommand(spec)
    if (configured.shell) return command.trim() === spec.command?.trim()
    let observed = splitCommand(command)
    const executable = (value: string) =>
      value
        .split(/[\\/]/)
        .at(-1)!
        .replace(/\.(exe|cmd|bat)$/i, '')
        .toLowerCase()
    if (
      ['bash', 'sh', 'zsh'].includes(executable(observed[0] ?? '')) &&
      observed[1]?.includes('c') &&
      observed[2]
    )
      observed = splitCommand(observed[2])
    return (
      executable(observed[0] ?? '') === executable(configured.executable) &&
      configured.args.every((arg, index) => observed[index + 1] === arg)
    )
  } catch {
    return false
  }
}
