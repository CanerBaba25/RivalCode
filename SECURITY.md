# Security and privacy

Agents run with the permissions granted by their own CLI and the current
operating system. RivalCode worktrees provide repository isolation between
benchmark participants but do not provide operating-system sandboxing.

RivalCode binds only to `127.0.0.1`. The local API rejects foreign Host/Origin
headers and has no telemetry or external event collector. The selected coding
agent may contact its own provider under its own configuration; RivalCode does
not bypass the agent's approval or sandbox policy. Network-deny configuration
fails clearly when a local adapter cannot enforce it.

Native reasoning/thinking records are discarded. Credentials, authorization and
cookie fields, known key patterns, secret environment values and dotenv values
are redacted before SQLite, event logs, verification artifacts, patches or
exports. Native tool output is off by default. Mandatory credential redaction
cannot be disabled with a configuration flag. Custom patterns can cover
organization-specific secrets. No pattern detector guarantees that every
arbitrary secret is recognizable; inspect artifacts before sharing them.

Git snapshots have a separate retention boundary. To compare an existing dirty
checkout accurately, RivalCode creates private snapshot commits with a temporary
Git index. Staging snapshots and final diffs writes eligible file contents into
the repository's existing `.git/objects` database before evidence redaction.
The original HEAD, references and index stay unchanged. Snapshot commits remain
unreferenced and are excluded from ordinary branch pushes, but their objects can
remain locally until Git garbage collection removes unreachable objects.

Keep `.env` and other credential files Git-ignored before running agents.
Git-ignored untracked files and configured ignore patterns are excluded from
snapshots; adding an ignore rule does not exclude an already tracked file.
RivalCode's redaction guarantee applies to its SQLite records, artifacts and
exports, and does not remove secrets from repository history or Git objects.

Agent processes use argument arrays. Verification strings are tokenized without
shell expansion; shell operators require explicit `shell: true`. Shell-enabled
checks execute trusted repository configuration with your current OS privileges.

The state directory, owned worktrees and artifact paths are checked for escape
and unsafe symlinks. Cleanup only removes owned inactive worktrees. Battles
reject dirty checkouts instead of stashing, resetting or committing your work.
Existing agent configuration is not overwritten. The temporary OpenCode
observer is owned by the session and has an ownership-aware uninstall command.

Report suspected vulnerabilities privately using GitHub's private vulnerability
reporting for [RivalCode](https://github.com/CanerBaba25/RivalCode/security).
Avoid publishing tokens, dotenv contents or unredacted run artifacts in issues.
