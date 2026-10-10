# Agent adapters

Each adapter implements detection, capabilities, prepared argument arrays and
allowlisted normalization. No agent installation or paid model access is required
for local unit/fixture/integration validation. CLI execution requires your installed agent and
its existing authentication. A readiness probe does not prove model entitlement.

| Agent       | Integration                                                                    | Accounting                                                                  |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Codex       | `codex exec --json`, prompt on stdin; workspace-write, no unresolved approvals | Native turn token counts; dollar cost/model may be unavailable              |
| Claude Code | Noninteractive `-p`, verbose `stream-json`                                     | Terminal cumulative usage; native client cost is explicitly estimated       |
| Gemini CLI  | Noninteractive prompt, `stream-json`                                           | Final token statistics; monetary cost unavailable unless configured pricing |
| OpenCode    | `run --format json` plus a temporary project observer plugin                   | Native step usage/reported model accounting; invoice not implied            |
| Demo Agent  | Explicit `--demo`, deterministic local edit and real Node tests                | No simulated model, tokens or costs                                         |

Native tool/command completion is parsed where exposed. The OpenCode observer
records documented tool lifecycle events without changing decisions, adding
dependencies or overwriting user config. Its session-owned file is removed before
Git capture. `rivalcode uninstall-hooks` removes only recognizable RivalCode
entries. [Integration implementation](../integrations/README.md).

Reasoning/thinking content is discarded, not recorded or displayed. Unknown event
types are ignored safely. Public tool output is disabled by default; tool names,
commands, status and file paths remain observable. The dashboard distinguishes
native capture from final Git observations and never invents intermediate diffs.

Codex/Claude native login status can confirm credentials are configured. Gemini
has no documented standalone auth-status command, so configuration presence is
reported as unverified. OpenCode readiness follows available documented CLI
capabilities. Missing optional agents do not block another installed adapter.

The local native integration tests use sanitized recorded schemas. Test files
are excluded from the public repository at its owner's request. They are not a claim
that all four paid agents were executed during development. Optional live smoke
tests require explicit opt-in and separately supplied vendor authentication.

Sources: [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Claude headless accounting](https://code.claude.com/docs/en/headless),
[Gemini headless mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md),
[OpenCode CLI](https://opencode.ai/docs/cli/),
[OpenCode plugins](https://opencode.ai/docs/plugins/).
