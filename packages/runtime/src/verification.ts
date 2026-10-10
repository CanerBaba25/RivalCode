import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CommandSpec, EventInput, RivalConfig, VerificationRun } from '@rivalcode/shared'
import { resolveCommand } from './config.js'
import { runProcess } from './process.js'

function bounded(value: string, limit: number): string {
  const bytes = Buffer.from(value)

  if (bytes.length <= limit) return value

  return (
    bytes.subarray(0, Math.max(0, limit - 40)).toString('utf8') + '\n[RivalCode output truncated]\n'
  )
}

export async function executeVerification(
  cwd: string,
  sessionId: string,
  specs: CommandSpec[],
  phase: VerificationRun['phase'],
  config: RivalConfig,
  artifactDir: string,
  redact: (value: unknown) => unknown,
  signal?: AbortSignal,
  onEvent?: (event: EventInput) => void
): Promise<VerificationRun[]> {
  await mkdir(artifactDir, { recursive: true })
  const actualDir = await realpath(artifactDir)
  const results: VerificationRun[] = []

  for (const spec of specs) {
    const id = randomUUID()
    const startedAt = new Date().toISOString()
    const command = resolveCommand(spec)
    const label =
      spec.command ??
      [
        command.executable,
        ...command.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
      ].join(' ')
    const safeLabel = String(redact(label))

    onEvent?.({
      type: 'verification_started',
      source: 'rivalcode',
      nativeId: `${id}:start`,
      timestamp: startedAt,
      payload: {
        verificationId: id,
        checkId: spec.id,
        phase,
        command: safeLabel,
        required: spec.required
      }
    })

    const result = signal?.aborted
      ? {
          exitCode: null,
          timedOut: false,
          aborted: true,
          stdout: '',
          stderr: 'Verification cancelled',
          durationMs: 0,
          truncated: false
        }
      : await runProcess(command.executable, command.args, {
          cwd,
          shell: command.shell,
          signal,
          timeoutMs: (spec.timeoutSeconds ?? config.battle.timeoutMinutes * 60) * 1000,
          maxOutputBytes: config.limits.maxArtifactBytes
        })

    const stdout = bounded(String(redact(result.stdout)), config.limits.maxArtifactBytes)
    const stderr = bounded(String(redact(result.stderr)), config.limits.maxArtifactBytes)
    const filePrefix = `${phase}-${id}`
    const stdoutPath = path.join(actualDir, `${filePrefix}.stdout.txt`)
    const stderrPath = path.join(actualDir, `${filePrefix}.stderr.txt`)

    await writeFile(stdoutPath, stdout, { flag: 'wx', mode: 0o600 })
    await writeFile(stderrPath, stderr, { flag: 'wx', mode: 0o600 })

    const run: VerificationRun = {
      id,
      sessionId,
      checkId: spec.id,
      command: safeLabel,
      phase,
      required: spec.required,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      passed: result.exitCode === 0 && !result.timedOut && !result.aborted,
      timedOut: result.timedOut,
      stdoutPath,
      stderrPath,
      stdout,
      stderr
    }

    results.push(run)

    onEvent?.({
      type: 'verification_finished',
      source: 'rivalcode',
      nativeId: `${id}:finish`,
      timestamp: run.finishedAt,
      payload: {
        verificationId: id,
        checkId: spec.id,
        phase,
        required: spec.required,
        passed: run.passed,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        truncated: result.truncated
      }
    })
  }

  return results
}
