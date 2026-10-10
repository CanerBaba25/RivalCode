import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Store, createRedactor, loadConfig } from '@rivalcode/runtime'
import type { Session } from '@rivalcode/shared'
import { redactBattle, redactEvent, redactSession } from './privacy.js'

const escape = (value: unknown) =>
  String(value ?? 'N/A')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')

const cost = (session: Session) => {
  const value = session.usage.costUsd
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'N/A'

  const amount = value > 0 && value < 0.0001 ? value.toPrecision(2) : value.toFixed(4)

  return `$${amount} (${session.usage.costType ?? 'unknown'}; ${session.usage.source ?? 'agent telemetry'})`
}

const tokens = (session: Session) => {
  const usage = session.usage
  if (
    typeof usage.totalTokens !== 'number' ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens < 0
  )
    return 'N/A'

  const scope =
    usage.tokenScope === 'main-agent'
      ? 'main agent only; excludes subagents'
      : usage.tokenScope === 'unknown' ||
          (session.agentId === 'claude' && usage.tokenScope !== 'session')
        ? 'accounting scope unverified'
        : usage.tokenScope === 'session'
          ? 'session total'
          : 'provider-reported totals'

  return `${usage.totalTokens} (${scope}${usage.modelScope === 'mixed' ? '; mixed models' : ''})`
}

export async function exportRecord(
  root: string,
  id: string,
  format: 'json' | 'markdown'
): Promise<string> {
  const store = new Store(root)
  try {
    const config = await loadConfig(root)
    const redact = await createRedactor(root, config)
    const session = store.getSession(id)
    const battle = session ? undefined : store.getBattle(id)
    if (!session && !battle) throw new Error(`No session or battle found: ${id}`)
    const sessions = session
      ? [session]
      : battle!.sessionIds
          .map((item) => store.getSession(item))
          .filter((item): item is Session => item !== undefined)
    const records = []
    for (const item of sessions) {
      const repository = await realpath(path.dirname(store.stateDir))
      const state = await realpath(store.stateDir)
      const stateRelative = path.relative(repository, state)
      if (
        !stateRelative ||
        stateRelative === '..' ||
        stateRelative.startsWith('..' + path.sep) ||
        path.isAbsolute(stateRelative)
      )
        throw new Error('RivalCode state directory escapes the repository')

      const events = []
      for (let offset = 0; ; offset += 500) {
        const page = store.getEvents(item.id, 500, offset)
        for (const original of page.items) {
          const safe = redactEvent(original, config, redact)
          if (safe) events.push(safe)
        }
        if (offset + page.items.length >= page.total) break
      }

      let diff = ''
      let artifactDir = item.artifactDir
      if (artifactDir.includes('[REDACTED]')) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(item.id))
          throw new Error('Invalid session artifact identity')
        artifactDir = path.join(state, 'sessions', item.id)
      }

      const outsideState = (candidate: string) => {
        const relative = path.relative(state, candidate)
        return (
          relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        )
      }
      if (outsideState(path.resolve(artifactDir))) throw new Error('Invalid session artifact path')
      try {
        const directory = await realpath(artifactDir)
        if (outsideState(directory)) throw new Error('Invalid session artifact path')

        const file = path.join(directory, 'final.diff')
        const before = await lstat(file, { bigint: true })
        if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n)
          throw new Error('Refusing an unsafe session diff')

        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
        const descriptor = await open(file, flags)
        try {
          const info = await descriptor.stat({ bigint: true })
          if (
            !info.isFile() ||
            info.nlink !== 1n ||
            info.dev !== before.dev ||
            info.ino !== before.ino ||
            info.size !== before.size ||
            info.mtimeNs !== before.mtimeNs
          )
            throw new Error('Refusing an unsafe session diff')

          const limit = BigInt(config.limits.maxArtifactBytes)
          const size = Number(info.size > limit ? limit : info.size)
          const buffer = Buffer.alloc(size)
          let length = 0
          while (length < size) {
            const result = await descriptor.read(buffer, length, size - length, length)
            if (!result.bytesRead) break
            length += result.bytesRead
          }

          const after = await descriptor.stat({ bigint: true })
          if (
            length !== size ||
            !after.isFile() ||
            after.nlink !== 1n ||
            after.dev !== info.dev ||
            after.ino !== info.ino ||
            after.size !== info.size ||
            after.mtimeNs !== info.mtimeNs
          )
            throw new Error('Refusing an unsafe session diff')

          diff = buffer.toString('utf8')
          if (info.size > BigInt(size)) diff += '\n[RivalCode diff truncated]\n'
        } finally {
          await descriptor.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      records.push({ ...redactSession(item, redact, config), events, diff: String(redact(diff)) })
    }
    const safeBattle = battle ? redactBattle(battle, redact, config) : undefined
    if (format === 'json')
      return JSON.stringify(
        safeBattle ? { battle: safeBattle, sessions: records } : records[0],
        null,
        2
      )
    if (format !== 'markdown') throw new Error('Export format must be json or markdown')
    const lines = [
      battle ? '# RivalCode Battle' : '# RivalCode Session',
      '',
      `Task: ${escape(safeBattle?.task ?? records[0]?.task ?? '[not stored]')}`,
      `Base commit: ${safeBattle?.baseCommit ?? records[0]?.baseCommit}`,
      '',
      '| Agent | Result | Required checks | Score | Duration | Files | Tokens | Cost |',
      '|---|---|---|---:|---:|---:|---:|---|'
    ]
    for (const item of records)
      lines.push(
        `| ${item.demo ? 'Demo Agent' : item.agentId} | ${item.status} | ${item.score?.verificationAvailable ? (item.score.requiredPassed ? 'PASS' : 'FAIL') : 'N/A'} | ${item.score?.total ?? 'N/A'} | ${(item.durationMs / 1000).toFixed(1)}s | ${item.files.length} | ${escape(tokens(item))} | ${escape(cost(item))} |`
      )
    if (battle)
      lines.push(
        '',
        `Winner: ${battle.winnerSessionId ? records.find((s) => s.id === battle.winnerSessionId)?.agentId : battle.tiedSessionIds.length ? 'Tie' : 'No eligible winner'}`,
        '',
        'Ranking: required checks pass first, score, fewer failed verification attempts, duration, patch size. Exact ties remain ties.'
      )
    for (const item of records) {
      lines.push(
        '',
        `## ${item.demo ? 'Demo Agent' : item.agentId}: ${item.id}`,
        '',
        ...(item.score?.explanation ?? []),
        '',
        '### Verification',
        ''
      )
      for (const check of item.verification)
        lines.push(
          `- ${escape(check.phase)} / ${escape(check.checkId)}: ${check.passed ? 'PASS' : 'FAIL'} (exit ${check.exitCode ?? 'N/A'}) — ${escape(check.command)}`
        )
      lines.push(
        '',
        '### Findings',
        '',
        ...(item.findings.length
          ? item.findings.map(
              (f) =>
                `- ${escape(f.title)}: ${escape(f.detail)}; evidence ${escape(JSON.stringify(f.evidence))}`
            )
          : ['No deterministic findings.']),
        '',
        '### Final diff',
        '',
        '```diff',
        item.diff.replaceAll('```', '` ` `'),
        '```'
      )
    }
    return lines.join('\n')
  } finally {
    store.close()
  }
}
