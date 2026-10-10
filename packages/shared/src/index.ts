export type AgentId = 'codex' | 'claude' | 'gemini' | 'opencode' | 'demo'
export type RunStatus = 'preparing' | 'running' | 'verifying' | 'completed' | 'failed' | 'aborted'
export type EventType =
  | 'session_started'
  | 'session_finished'
  | 'task'
  | 'assistant_output'
  | 'tool_started'
  | 'tool_finished'
  | 'command_started'
  | 'command_finished'
  | 'file_changed'
  | 'permission_requested'
  | 'permission_resolved'
  | 'usage'
  | 'cost'
  | 'error'
  | 'verification_started'
  | 'verification_finished'
  | 'finding'
export interface EventInput {
  type: EventType
  source: 'native' | 'hook' | 'otel' | 'process' | 'git' | 'rivalcode'
  payload: Record<string, unknown>
  timestamp?: string
  nativeId?: string
}
export interface NormalizedEvent extends EventInput {
  id: string
  sessionId: string
  agentId: AgentId
  timestamp: string
}
export interface AgentCapabilities {
  structuredEvents: boolean
  toolEvents: boolean
  commandEvents: boolean
  tokenUsage: boolean
  providerCost: boolean
  modelIdentity: boolean
  interactiveMode: boolean
}
export interface AgentDetection {
  id: AgentId
  displayName: string
  installed: boolean
  version: string | null
  auth: 'ready' | 'missing' | 'unknown'
  detail?: string
  capabilities: AgentCapabilities
}
export interface CommandSpec {
  id: string
  command?: string
  executable?: string
  args?: string[]
  required: boolean
  shell?: boolean
  timeoutSeconds?: number
}
export interface RivalConfig {
  version: 1
  verification: { commands: CommandSpec[]; runBaseline: boolean }
  setup: CommandSpec[]
  battle: { timeoutMinutes: number; parallel: boolean; network: 'inherit' | 'deny' }
  privacy: {
    storeTaskPrompt: boolean
    storeAssistantOutput: boolean
    storeToolOutput: boolean
    redactSecrets: boolean
    customRedactions: string[]
  }
  scoring: { enabled: boolean; maxFiles: number; maxLines: number }
  ignore: string[]
  forbiddenPaths: string[]
  agents: Partial<Record<AgentId, { model?: string; args?: string[] }>>
  dashboard: { port: number }
  limits: { maxArtifactBytes: number; maxEventBytes: number }
  pricing: Record<
    string,
    { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number }
  >
}
export interface UsageRecord {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
  model?: string
  modelSource?: 'configured' | 'native'
  modelScope?: 'single' | 'mixed' | 'unknown'
  tokenScope?: 'session' | 'main-agent' | 'unknown'
  costUsd?: number
  costType?: 'provider_reported' | 'estimated' | 'unknown'
  source?: string
}
export interface FileChange {
  path: string
  oldPath?: string
  status: string
  additions: number
  deletions: number
  binary: boolean
}
export interface GitSnapshot {
  head: string
  status: string
  diff: string
  files: FileChange[]
}
export interface VerificationRun {
  id: string
  sessionId: string
  checkId: string
  command: string
  phase: 'baseline' | 'final' | 'setup'
  required: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number | null
  passed: boolean
  timedOut: boolean
  stdoutPath?: string
  stderrPath?: string
  stdout?: string
  stderr?: string
}
export interface Finding {
  id: string
  type: string
  severity: 'info' | 'warning' | 'error'
  title: string
  detail: string
  evidence: { eventIds?: string[]; checkIds?: string[]; paths?: string[] }
}
export interface Score {
  total: number
  correctness: number
  codeHealth: number
  changeDiscipline: number
  reliability: number
  efficiency: number
  requiredPassed: boolean
  verificationAvailable: boolean
  explanation: string[]
}
export interface RepositoryRecord {
  id: string
  path: string
  name: string
  remoteUrl?: string
  projectType?: string
  createdAt: string
}
export interface Session {
  id: string
  repositoryId: string
  repositoryPath: string
  repositoryName: string
  agentId: AgentId
  agentVersion: string | null
  task: string | null
  model?: string
  modelSource?: 'configured' | 'native'
  baseCommit: string
  startedAt: string
  finishedAt?: string
  durationMs: number
  status: RunStatus
  score: Score | null
  exitCode: number | null
  usage: UsageRecord
  files: FileChange[]
  findings: Finding[]
  verification: VerificationRun[]
  capabilities: AgentCapabilities
  artifactDir: string
  worktreePath?: string
  battleId?: string
  error?: string
  pid: number
  demo: boolean
  tags: string[]
}
export interface Battle {
  id: string
  repositoryId: string
  repositoryName: string
  task: string | null
  baseCommit: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  sessionIds: string[]
  winnerSessionId: string | null
  tiedSessionIds: string[]
  ranking: { sessionId: string; rank: number }[]
  config: RivalConfig
}
export interface SessionFilter {
  agent?: string
  repository?: string
  status?: string
  from?: string
  to?: string
  minScore?: number
  maxScore?: number
  tag?: string
  projectType?: string
  incomplete?: boolean
  demo?: boolean
  limit?: number
  offset?: number
  sort?: string
  order?: 'asc' | 'desc'
}
export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}
export interface LeaderboardRow {
  agentId: AgentId
  runs: number
  successes: number
  successRate: number
  averageScore: number | null
  averageDurationMs: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  averageCostUsd: number | null
  costType: string
}
export interface PreparedRun {
  executable: string
  args: string[]
  stdin?: string
  env?: NodeJS.ProcessEnv
  cleanup?: () => Promise<void>
}
export interface RunContext {
  sessionId: string
  cwd: string
  repositoryRoot?: string
  task: string
  config: RivalConfig
  model?: string
  artifactDir: string
  demo: boolean
}
export interface AgentAdapter {
  id: AgentId
  displayName: string
  capabilities: AgentCapabilities
  detect(): Promise<AgentDetection>
  prepareRun(ctx: RunContext): Promise<PreparedRun>
  parseEvent(raw: unknown): EventInput[]
}
export interface ProcessResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
}
export interface ProcessOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  shell?: boolean
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}
export interface RunOptions {
  root: string
  agent: AgentId
  task: string
  config?: RivalConfig
  store?: unknown
  cwd?: string
  battleId?: string
  demo?: boolean
  tags?: string[]
  signal?: AbortSignal
  onEvent?: (event: NormalizedEvent) => void
  onProgress?: (message: string) => void
}
