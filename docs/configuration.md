# Configuration

`rivalcode init` creates `rivalcode.config.json` and `.rivalcode/`, adds the runtime
directory to Git ignores, detects common project checks, and preserves an existing
configuration. Review generated checks before running an agent.

```json
{
  "version": 1,
  "verification": {
    "runBaseline": true,
    "commands": [
      { "id": "test", "executable": "pnpm", "args": ["test"], "required": true },
      { "id": "typecheck", "executable": "pnpm", "args": ["typecheck"], "required": true }
    ]
  },
  "setup": [
    {
      "id": "install",
      "executable": "pnpm",
      "args": ["install", "--frozen-lockfile"],
      "required": true
    }
  ],
  "battle": { "timeoutMinutes": 30, "parallel": false, "network": "inherit" },
  "privacy": {
    "storeTaskPrompt": true,
    "storeAssistantOutput": true,
    "storeToolOutput": false,
    "redactSecrets": true,
    "customRedactions": []
  },
  "scoring": { "enabled": true, "maxFiles": 15, "maxLines": 2000 },
  "ignore": ["node_modules/**", "dist/**", "build/**", "coverage/**"],
  "forbiddenPaths": [".git/**", ".env", ".env.*"],
  "agents": {},
  "dashboard": { "port": 4317 },
  "limits": { "maxArtifactBytes": 1048576, "maxEventBytes": 65536 },
  "pricing": {}
}
```

Missing settings use validated defaults. Shorthand verification keys such as
`"test": "npm test"` are supported. Prefer `executable` plus literal `args`.
String commands do not evaluate shell expansions, redirections or pipelines.
Use explicit `shell: true` only for trusted checks that need a shell; agent
invocations never opt into it. `timeoutSeconds` can limit an individual check.

Setup runs in every participant's worktree. Configure install/build prerequisites
explicitly so all participants receive the same preparation. Ignored generated
paths are excluded from Git baseline/patch capture. Forbidden paths contribute
findings when captured; they are observations, not filesystem access controls.

Agent settings accept `model` and literal `args`. Permissions remain controlled by
the vendor CLI. For example, Claude permissions can be granted through documented
allowed-tools arguments; RivalCode does not automatically bypass prompts.
`network: "deny"` is rejected when a local adapter cannot guarantee isolation.

Project detection supports npm, pnpm, yarn, Bun, Python, Rust, Go, Gradle and Maven.
Agent credentials remain managed by each vendor and are never stored in SQLite.
Do not put credentials in RivalCode config or custom argument strings.

Optional `pricing` maps exact model IDs to `inputPerMillion`, `outputPerMillion`
and `cachedInputPerMillion`. Its result is explicitly labeled **Estimated
API-equivalent cost**, not your subscription bill. Unknown metrics stay `N/A`.
See [adapter accounting](adapters.md) for each native stream's limits.
