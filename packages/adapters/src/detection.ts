import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCapabilities, AgentDetection, AgentId } from '@rivalcode/shared'
import { runProcess } from '@rivalcode/runtime'
import { object } from './normalize.js'

async function probe(executable: string, args: string[]) {
  return runProcess(executable, args, {
    cwd: process.cwd(),
    timeoutMs: 5000,
    maxOutputBytes: 16384
  })
}
export async function detectAgent(
  id: AgentId,
  displayName: string,
  executable: string,
  capabilities: AgentCapabilities
): Promise<AgentDetection> {
  let version: string | null = null
  try {
    const result = await probe(executable, ['--version'])
    if (result.exitCode !== 0) {
      const installed =
        result.exitCode !== 127 &&
        result.exitCode !== null &&
        !/ENOENT|not recognized|could not be found|cannot find/i.test(result.stderr)
      return {
        id,
        displayName,
        installed,
        version,
        auth: installed ? 'unknown' : 'missing',
        capabilities,
        detail: installed
          ? 'Version check failed or timed out; inspect the agent installation'
          : `Install ${displayName} and ensure ${executable} is on PATH`
      }
    }
    version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.slice(0, 160) || null
  } catch {
    return {
      id,
      displayName,
      installed: false,
      version,
      auth: 'missing',
      capabilities,
      detail: `Install ${displayName} and ensure ${executable} is on PATH`
    }
  }
  let auth: AgentDetection['auth'] = 'unknown'
  let detail = 'Authentication was not verified; no inference request was made'
  try {
    if (id === 'codex') {
      const result = await probe(executable, ['login', 'status'])
      auth = result.timedOut ? 'unknown' : result.exitCode === 0 ? 'ready' : 'missing'
      detail =
        auth === 'ready'
          ? 'CLI reports credentials present; model access remains unverified'
          : auth === 'missing'
            ? 'Run codex login before starting a run'
            : 'Authentication status check timed out'
    } else if (id === 'claude') {
      const result = await probe(executable, ['auth', 'status'])
      let status: Record<string, unknown> = {}
      try {
        status = object(JSON.parse(result.stdout))
      } catch {
        /* Older CLIs can have an unsupported status subcommand. */
      }
      if (status.loggedIn === true || status.logged_in === true) auth = 'ready'
      else if (status.loggedIn === false || status.logged_in === false) auth = 'missing'
      detail =
        auth === 'ready'
          ? 'CLI reports a signed-in account; model access remains unverified'
          : auth === 'missing'
            ? 'Run claude auth login before starting a run'
            : 'This CLI did not provide a supported authentication status response'
    } else if (id === 'gemini') {
      let cached = false
      try {
        await access(join(homedir(), '.gemini', 'oauth_creds.json'))
        cached = true
      } catch {
        /* Presence only; credentials are never read. */
      }
      const configured = Boolean(
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.GOOGLE_GENAI_USE_VERTEXAI ||
        cached
      )
      detail = configured
        ? 'Credential configuration is present but unverified; Gemini has no documented non-inference auth status command'
        : 'Sign in with gemini or configure its documented API/Vertex authentication'
      // Cached/browser and external credential providers are not safely verifiable without inference.
    } else if (id === 'opencode') {
      const result = await probe(executable, ['auth', 'list'])
      detail =
        result.exitCode === 0
          ? 'Provider configuration was inspected without inference; authentication and model access remain unverified'
          : 'Provider status is unavailable; use opencode auth login to configure credentials'
    }
  } catch {
    detail = 'Authentication status check failed; no credentials or account details were captured'
  }
  return { id, displayName, installed: true, version, auth, capabilities, detail }
}
