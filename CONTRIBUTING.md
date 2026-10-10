# Contributing

Use Node.js 22.18+ and pnpm 10.33.2. The workspace uses strict TypeScript,
two-space indentation, single quotes and no semicolons. Leave blank lines
between logical steps; comments should explain an edge case or a decision.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
node dist/cli.js --help
pnpm demo
```

`pnpm dev:cli --help` runs the CLI from source. Build before `pnpm dev`, which
starts the bundled local dashboard. `pnpm dev:web` provides Vite reloads while
the local API is running. `pnpm demo` prepares an isolated labeled demo history
without paid model calls; use the printed repository path to open its dashboard.

Keep modules focused, validate external input, use literal process arguments,
and redact before writing evidence. Tests must use sanitized event fixtures and
temporary repositories. Normal CI must never require an agent account or a paid
model. Any live agent smoke run must be explicitly requested and opt-in.

Before submitting, run all checks above and explain the concrete behavior change
and relevant validation. Avoid committing local state, agent instructions, tool
configuration, dependency directories, generated builds or test recordings.

The repository owner keeps test suites and test configuration local, excluded
from Git. A public clone has no private test suite. If the local suites are
available, also run `pnpm test`, `pnpm exec playwright install chromium`, and
`pnpm test:e2e`. ESLint configuration also stays local; run `pnpm lint` when a
local config is available. Public CI validates typecheck, build, CLI help and
the real demo workflow on all three operating systems.

See [architecture](docs/architecture.md), [configuration](docs/configuration.md)
and [adapter behavior](docs/adapters.md) for extension points.
