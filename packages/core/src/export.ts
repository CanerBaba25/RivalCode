import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Store, createRedactor, loadConfig } from '@rivalcode/runtime'
import type { Session } from '@rivalcode/shared'
import { redactBattle, redactEvent, redactSession } from './privacy.js'

const escape = (value: unknown) =>
  String(value ?? 'N/A')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
const cost = (session: Session) =>
  session.usage.costUsd === undefined
    ? 'N/A'
    : `$${session.usage.costUsd.toFixed(4)} (${session.usage.costType}; ${session.usage.source ?? 'agent telemetry'})`

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
      const state = await realpath(store.stateDir)
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
        if (outsideState(await realpath(artifactDir)))
          throw new Error('Invalid session artifact path')
        const file = path.join(artifactDir, 'final.diff')
        if ((await lstat(file)).isSymbolicLink())
          throw new Error('Refusing a symlinked session diff')
        const descriptor = await open(file, 'r')
        try {
          const info = await descriptor.stat()
          const size = Math.min(info.size, config.limits.maxArtifactBytes)
          const buffer = Buffer.alloc(size)
          const result = await descriptor.read(buffer, 0, size, 0)
          diff = buffer.subarray(0, result.bytesRead).toString('utf8')
          if (info.size > size) diff += '\n[RivalCode diff truncated]\n'
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
        `| ${item.demo ? 'Demo Agent' : item.agentId} | ${item.status} | ${item.score?.verificationAvailable ? (item.score.requiredPassed ? 'PASS' : 'FAIL') : 'N/A'} | ${item.score?.total ?? 'N/A'} | ${(item.durationMs / 1000).toFixed(1)}s | ${item.files.length} | ${item.usage.totalTokens ?? 'N/A'} | ${escape(cost(item))} |`
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
