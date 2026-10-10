# Agent event integrations

RivalCode starts the user's installed coding agent. It does not install an agent,
sign in, replace credentials, or run a paid request during adapter detection.

| Adapter     | Event transport                                  | Authentication detection                 | Cost fidelity                                               |
| ----------- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| Codex       | `exec --json`                                    | `login status` exit code                 | Unknown unless explicitly estimated from configured pricing |
| Claude Code | `-p --output-format stream-json --verbose`       | `auth status` boolean only               | Claude client estimate, cumulative                          |
| Gemini CLI  | `-p --output-format stream-json`                 | Configuration/cache presence, unverified | Unknown unless explicitly estimated from configured pricing |
| OpenCode    | `run --format json` and a temporary local plugin | `auth list`, unverified                  | Model token-price estimate, incremental                     |

Native streams are parsed incrementally with bounded line sizes. Unknown event
schemas are ignored, while malformed/oversized JSONL produces a capture error
without retaining the malformed contents. Reasoning, thinking, analysis, user
messages, generic arguments and unknown fields do not enter normalized events.
Tool output follows the core privacy configuration and defaults to off.

Claude and Gemini preserve the user's configured permission policy. Headless
permission denials remain visible evidence. Configure documented agent arguments
in `agents.<id>.args` when a task needs additional pre-approved tools. RivalCode
does not add a permission-bypass flag. A denied-network policy requires an
external isolation mechanism; the local adapters reject that policy instead of
claiming that a worktree blocks network access.

Codex turn and OpenCode step usage records are incremental. Claude and Gemini
terminal usage records are cumulative and replace earlier totals. Cache reads
are subsets of the normalized input total. Claude cache-creation and OpenCode
cache-write tokens are added to their provider's uncached input to make that
relationship explicit. Token counts remain unknown when the native schema does
not expose them. OpenCode's separately reported reasoning token count is included
in output totals without retaining reasoning content. Cost provenance is separate
from subscription billing.

The OpenCode adapter creates a uniquely named `.opencode/plugins/rivalcode-*.js`
file using exclusive creation. It uses only Node built-ins and does not alter
`opencode.json`, user plugins, or global configuration. Its `tool.execute.before`
observer captures actual start times because OpenCode's CLI emits tool events at
completion. Model-only metadata comes from assistant message updates. Session,
file and permission events use the public event hook. The adapter tolerates both
`properties` and `data` event envelopes.

For file edit observations, it hashes regular files up to 1 MiB inside the project
so rewrite/revert findings can link to intermediate evidence. File contents,
`.env` files, internal state, dependencies, symlinks and paths outside the project
are excluded from this hashing. Larger edits still report their path without a
hash. Native terminal failures stay failures even when a CLI exits with code zero;
recoverable tool failures remain individual observations.

`RIVALCODE_CAPTURE_PATH` points to a bounded JSONL file in the run's artifact
directory. The observer stores allowlisted fields after redacting credential
patterns, secret environment values, local `.env` values, and custom redaction
expressions. It returns no tool decisions, context additions, or result changes.
Core reads this file incrementally and applies its privacy boundary again.

Cleanup removes a plugin only when its full contents still match RivalCode's
owned source. It removes newly created empty directories, and preserves existing
or subsequently modified user files. `rivalcode uninstall-hooks` also recognizes
only exact, unmodified owned plugins. Symbolic link paths are rejected.

`collector.ts` additionally contains a standalone stdin collector for the public
Claude/Gemini hook schemas. Native streams are used for their standard benchmark
runs, so installing that collector is unnecessary. It prints `{}` and exits zero
without approval decisions or prompt modifications.

The Demo Agent requires explicit demo mode. It performs an actual local edit
and invokes `node --test`; it reports no simulated provider tokens or cost.

The automated fixtures are sanitized schema examples, not recordings of paid
model executions. Live provider smoke tests remain an explicit opt-in check.

Sources:

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Claude headless mode and permission policy](https://code.claude.com/docs/en/headless)
- [Claude hook reference](https://code.claude.com/docs/en/hooks)
- [Gemini headless output](https://geminicli.com/docs/cli/headless/)
- [Gemini stream event types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode non-interactive stream implementation](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/run/noninteractive.ts)
- [OpenCode token and cost calculation](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/usage.ts)
