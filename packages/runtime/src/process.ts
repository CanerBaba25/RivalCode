import spawn from 'cross-spawn'
import { StringDecoder } from 'node:string_decoder'
import type { ProcessOptions, ProcessResult } from '@rivalcode/shared'

/** Execute literal argument vectors; shells are available only for explicit check opt-in. */
export function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  if (!executable || executable.includes('\0') || args.some((arg) => arg.includes('\0')))
    return Promise.reject(new Error('Invalid process command'))

  const start = performance.now()
  const cap = options.maxOutputBytes ?? 1024 * 1024

  if (!Number.isSafeInteger(cap) || cap < 0)
    return Promise.reject(new Error('Invalid output limit'))

  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2147483647)
  )
    return Promise.reject(new Error('Invalid process timeout'))

  if (options.signal?.aborted)
    return Promise.resolve({
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      durationMs: 0,
      stdout: '',
      stderr: '',
      truncated: false
    })

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false
    let stopping = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let observerError: Error | undefined

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: options.shell === true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const retained = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }

    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = decoders[kind].write(chunk)

      // Streaming consumers receive complete decoded chunks and must apply their own event bounds.
      try {
        ;(kind === 'stdout' ? options.onStdout : options.onStderr)?.(text)
      } catch (error) {
        observerError = error instanceof Error ? error : new Error(String(error))
        stop('abort')
      }

      const remaining = Math.max(0, cap - bytes)
      const accepted = chunk.subarray(0, remaining)
      bytes += accepted.length

      if (accepted.length < chunk.length) truncated = true

      const value = retained[kind].write(accepted)
      if (kind === 'stdout') stdout += value
      else stderr += value
    }

    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk))

    const terminate = (force = false) => {
      if (!child.pid) return

      if (process.platform === 'win32') {
        // /T owns descendants; /F is needed because Node cannot send graceful Windows tree signals.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })

        killer.on('error', () => {
          try {
            child.kill()
          } catch {
            /* already exited */
          }
        })
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
        } catch {
          try {
            child.kill(force ? 'SIGKILL' : 'SIGTERM')
          } catch {
            /* already exited */
          }
        }
      }
    }

    const stop = (reason: 'timeout' | 'abort') => {
      if (stopping) return

      stopping = true
      timedOut = reason === 'timeout'
      aborted = reason === 'abort'
      terminate()
      escalation = setTimeout(() => terminate(true), 1000)
      escalation.unref()
    }

    const abort = () => stop('abort')

    if (options.timeoutMs !== undefined)
      timeout = setTimeout(() => stop('timeout'), Math.max(1, options.timeoutMs))

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()

    child.on('error', (error) => {
      const remaining = Math.max(0, cap - bytes)
      stderr += Buffer.from(error.message).subarray(0, remaining).toString('utf8')
    })

    child.on('close', (exitCode, signal) => {
      if (timeout) clearTimeout(timeout)
      // The leader can exit before descendants that ignored the first group signal.
      if (stopping && process.platform !== 'win32') terminate(true)
      if (escalation) clearTimeout(escalation)
      options.signal?.removeEventListener('abort', abort)

      for (const kind of ['stdout', 'stderr'] as const) {
        const tail = decoders[kind].end()

        if (tail) {
          try {
            ;(kind === 'stdout' ? options.onStdout : options.onStderr)?.(tail)
          } catch (error) {
            observerError = error instanceof Error ? error : new Error(String(error))
            terminate(true)
          }
        }
      }

      if (observerError) {
        reject(observerError)
        return
      }

      resolve({
        exitCode,
        signal,
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - start),
        stdout,
        stderr,
        truncated
      })
    })

    child.stdin?.on('error', () => {
      /* Early exit can close stdin before the prompt is written. */
    })
    child.stdin?.end(options.stdin)
  })
}
