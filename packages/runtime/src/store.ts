import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AgentId,
  Battle,
  LeaderboardRow,
  NormalizedEvent,
  Page,
  RepositoryRecord,
  Session,
  SessionFilter
} from '@rivalcode/shared'

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        remote_url TEXT,
        project_type TEXT,
        created_at TEXT NOT NULL,
        document TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        agent_id TEXT NOT NULL,
        agent_version TEXT,
        model TEXT,
        task TEXT,
        base_commit TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        score REAL,
        exit_code INTEGER,
        pid INTEGER NOT NULL,
        demo INTEGER NOT NULL,
        battle_id TEXT,
        document TEXT NOT NULL
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        document TEXT NOT NULL
      );

      CREATE TABLE usage (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        total_tokens INTEGER,
        model TEXT,
        cost_usd REAL,
        cost_type TEXT,
        source TEXT,
        document TEXT NOT NULL
      );

      CREATE TABLE file_changes (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        old_path TEXT,
        status TEXT NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        binary INTEGER NOT NULL,
        document TEXT NOT NULL,
        PRIMARY KEY(session_id, path)
      );

      CREATE TABLE verification_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        check_id TEXT NOT NULL,
        command TEXT NOT NULL,
        phase TEXT NOT NULL,
        required INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        exit_code INTEGER,
        passed INTEGER NOT NULL,
        timed_out INTEGER NOT NULL,
        stdout_path TEXT,
        stderr_path TEXT,
        document TEXT NOT NULL
      );

      CREATE TABLE findings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        document TEXT NOT NULL
      );

      CREATE TABLE battles (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        task TEXT,
        base_commit TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        winner_session_id TEXT,
        status TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        document TEXT NOT NULL
      );

      CREATE TABLE battle_sessions (
        battle_id TEXT NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        rank INTEGER,
        PRIMARY KEY(battle_id, session_id)
      );

      CREATE INDEX sessions_repository_started ON sessions(repository_id, started_at DESC);
      CREATE INDEX sessions_agent_status_started ON sessions(agent_id, status, started_at DESC);
      CREATE INDEX sessions_score ON sessions(score);
      CREATE INDEX events_session_timestamp ON events(session_id, timestamp, id);
      CREATE INDEX events_session_type ON events(session_id, type, timestamp);
      CREATE INDEX verification_session_phase ON verification_runs(session_id, phase, check_id);
      CREATE INDEX findings_session_severity ON findings(session_id, severity);
      CREATE INDEX battles_repository_started ON battles(repository_id, started_at DESC);
      CREATE INDEX battle_sessions_session ON battle_sessions(session_id);
`
  }
]

function pageBounds(filter: Pick<SessionFilter, 'limit' | 'offset'>) {
  return {
    limit: Math.min(
      500,
      Math.max(1, Math.trunc(Number.isFinite(filter.limit) ? filter.limit! : 50))
    ),
    offset: Math.max(0, Math.trunc(Number.isFinite(filter.offset) ? filter.offset! : 0))
  }
}

function isLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function decode<T>(row: Record<string, unknown> | undefined): T | undefined {
  return row ? (JSON.parse(String(row.document)) as T) : undefined
}

function sessionWhere(filter: SessionFilter): { clause: string; values: SQLInputValue[] } {
  const clauses: string[] = []
  const values: SQLInputValue[] = []
  const add = (sql: string, value: SQLInputValue) => {
    clauses.push(sql)
    values.push(value)
  }

  if (filter.agent) add('s.agent_id=?', filter.agent)
  if (filter.repository) {
    clauses.push('(s.repository_id=? OR r.name=? OR r.path=?)')
    values.push(filter.repository, filter.repository, filter.repository)
  }

  if (filter.status) add('s.status=?', filter.status)
  if (filter.from) add('s.started_at>=?', filter.from)
  if (filter.to) add('s.started_at<=?', filter.to)
  if (filter.minScore !== undefined) add('s.score>=?', filter.minScore)
  if (filter.maxScore !== undefined) add('s.score<=?', filter.maxScore)

  if (filter.tag)
    add("EXISTS(SELECT 1 FROM json_each(s.document,'$.tags') WHERE value=?)", filter.tag)
  if (filter.projectType) add('r.project_type=?', filter.projectType)
  if (filter.incomplete !== undefined)
    clauses.push(
      `s.status ${filter.incomplete ? 'IN' : 'NOT IN'} ('preparing','running','verifying','aborted')`
    )

  if (filter.demo !== undefined) add('s.demo=?', Number(filter.demo))

  return { clause: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', values }
}

/** Numbered, transactional migrations with typed document reads and indexed relational writes. */
export class Store {
  readonly stateDir: string
  readonly dbPath: string
  private db: DatabaseSync

  constructor(root: string) {
    const resolvedRoot = realpathSync(root)
    this.stateDir = path.join(resolvedRoot, '.rivalcode')
    mkdirSync(this.stateDir, { recursive: true })

    const actualState = realpathSync(this.stateDir)
    const relative = path.relative(resolvedRoot, actualState)

    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('RivalCode state directory escapes the repository')

    this.dbPath = path.join(actualState, 'rivalcode.sqlite')
    for (const filename of [this.dbPath, this.dbPath + '-wal', this.dbPath + '-shm'])
      if (existsSync(filename) && lstatSync(filename).isSymbolicLink())
        throw new Error('Refusing a symlinked RivalCode database')

    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;'
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
    )

    const version = Number(
      this.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()
        ?.version ?? 0
    )

    if (version > migrations.at(-1)!.version) {
      this.db.close()
      throw new Error('Database schema is newer than this RivalCode version')
    }

    for (const migration of migrations)
      if (migration.version > version)
        this.transaction(() => {
          if (
            this.db
              .prepare('SELECT version FROM schema_migrations WHERE version=?')
              .get(migration.version)
          )
            return

          this.db.exec(migration.sql)
          this.db
            .prepare('INSERT INTO schema_migrations VALUES (?,?)')
            .run(migration.version, new Date().toISOString())
          this.db.exec(`PRAGMA user_version=${migration.version}`)
        })
  }

  private transaction(callback: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')

    try {
      callback()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  upsertRepository(record: RepositoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO repositories VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           path=excluded.path,
           name=excluded.name,
           remote_url=excluded.remote_url,
           project_type=excluded.project_type,
           document=excluded.document`
      )
      .run(
        record.id,
        record.path,
        record.name,
        record.remoteUrl ?? null,
        record.projectType ?? null,
        record.createdAt,
        JSON.stringify(record)
      )
  }

  saveSession(session: Session): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             repository_id=excluded.repository_id,
             agent_id=excluded.agent_id,
             agent_version=excluded.agent_version,
             model=excluded.model,
             task=excluded.task,
             base_commit=excluded.base_commit,
             started_at=excluded.started_at,
             finished_at=excluded.finished_at,
             duration_ms=excluded.duration_ms,
             status=excluded.status,
             score=excluded.score,
             exit_code=excluded.exit_code,
             pid=excluded.pid,
             demo=excluded.demo,
             battle_id=excluded.battle_id,
             document=excluded.document`
        )
        .run(
          session.id,
          session.repositoryId,
          session.agentId,
          session.agentVersion,
          session.model ?? null,
          session.task,
          session.baseCommit,
          session.startedAt,
          session.finishedAt ?? null,
          session.durationMs,
          session.status,
          session.score?.total ?? null,
          session.exitCode,
          session.pid,
          Number(session.demo),
          session.battleId ?? null,
          JSON.stringify(session)
        )

      const usage = session.usage
      this.db
        .prepare(
          `INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET
             input_tokens=excluded.input_tokens,
             output_tokens=excluded.output_tokens,
             cached_tokens=excluded.cached_tokens,
             total_tokens=excluded.total_tokens,
             model=excluded.model,
             cost_usd=excluded.cost_usd,
             cost_type=excluded.cost_type,
             source=excluded.source,
             document=excluded.document`
        )
        .run(
          session.id,
          usage.inputTokens ?? null,
          usage.outputTokens ?? null,
          usage.cachedInputTokens ?? null,
          usage.totalTokens ?? null,
          usage.model ?? null,
          usage.costUsd ?? null,
          usage.costType ?? null,
          usage.source ?? null,
          JSON.stringify(usage)
        )

      for (const table of ['file_changes', 'verification_runs', 'findings'])
        this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(session.id)

      const insertFile = this.db.prepare('INSERT INTO file_changes VALUES (?,?,?,?,?,?,?,?)')

      for (const file of session.files)
        insertFile.run(
          session.id,
          file.path,
          file.oldPath ?? null,
          file.status,
          file.additions,
          file.deletions,
          Number(file.binary),
          JSON.stringify(file)
        )

      const insertCheck = this.db.prepare(
        'INSERT INTO verification_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )

      for (const check of session.verification)
        insertCheck.run(
          check.id,
          session.id,
          check.checkId,
          check.command,
          check.phase,
          Number(check.required),
          check.startedAt,
          check.finishedAt,
          check.durationMs,
          check.exitCode,
          Number(check.passed),
          Number(check.timedOut),
          check.stdoutPath ?? null,
          check.stderrPath ?? null,
          JSON.stringify(check)
        )

      const insertFinding = this.db.prepare('INSERT INTO findings VALUES (?,?,?,?,?,?,?,?)')

      for (const finding of session.findings)
        insertFinding.run(
          finding.id,
          session.id,
          finding.type,
          finding.severity,
          finding.title,
          finding.detail,
          JSON.stringify(finding.evidence),
          JSON.stringify(finding)
        )

      if (
        session.battleId &&
        this.db.prepare('SELECT id FROM battles WHERE id=?').get(session.battleId)
      )
        this.db
          .prepare(
            `INSERT INTO battle_sessions VALUES (?,?,?,NULL)
             ON CONFLICT(battle_id,session_id) DO UPDATE SET agent_id=excluded.agent_id`
          )
          .run(session.battleId, session.id, session.agentId)
    })
  }

  getSession(id: string): Session | undefined {
    return decode<Session>(this.db.prepare('SELECT document FROM sessions WHERE id=?').get(id))
  }

  listSessions(filter: SessionFilter = {}): Page<Session> {
    const { clause, values } = sessionWhere(filter)
    const { limit, offset } = pageBounds(filter)
    const sorts: Record<string, string> = {
      startedAt: 's.started_at',
      durationMs: 's.duration_ms',
      score: 's.score',
      tokens: 'u.total_tokens',
      cost: 'u.cost_usd',
      files: "json_array_length(s.document,'$.files')",
      agentId: 's.agent_id',
      repositoryName: 'r.name',
      status: 's.status'
    }

    const order = filter.order === 'asc' ? 'ASC' : 'DESC'
    const sort = sorts[filter.sort ?? 'startedAt'] ?? sorts.startedAt!
    const from =
      ' FROM sessions s JOIN repositories r ON r.id=s.repository_id LEFT JOIN usage u ON u.session_id=s.id'

    const total = Number(
      this.db.prepare('SELECT COUNT(*) AS total' + from + clause).get(...values)?.total ?? 0
    )

    const rows = this.db
      .prepare(
        `SELECT s.document${from}${clause} ORDER BY ${sort} ${order},s.id ${order} LIMIT ? OFFSET ?`
      )
      .all(...values, limit, offset)

    return { items: rows.map((row) => decode<Session>(row)!), total, limit, offset }
  }

  appendEvents(events: NormalizedEvent[]): void {
    if (!events.length) return

    this.transaction(() => {
      const statement = this.db.prepare(
        'INSERT INTO events VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING'
      )

      for (const event of events)
        statement.run(
          event.id,
          event.sessionId,
          event.agentId,
          event.timestamp,
          event.type,
          event.source,
          JSON.stringify(event.payload),
          JSON.stringify(event)
        )
    })
  }

  getEvents(sessionId: string, limit = 200, offset = 0): Page<NormalizedEvent> {
    const bounds = pageBounds({ limit, offset })
    const total = Number(
      this.db.prepare('SELECT COUNT(*) AS total FROM events WHERE session_id=?').get(sessionId)
        ?.total ?? 0
    )

    return {
      items: this.db
        .prepare(
          'SELECT document FROM events WHERE session_id=? ORDER BY timestamp,rowid LIMIT ? OFFSET ?'
        )
        .all(sessionId, bounds.limit, bounds.offset)
        .map((row) => decode<NormalizedEvent>(row)!),
      total,
      ...bounds
    }
  }

  saveBattle(battle: Battle): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO battles VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             repository_id=excluded.repository_id,
             task=excluded.task,
             base_commit=excluded.base_commit,
             finished_at=excluded.finished_at,
             winner_session_id=excluded.winner_session_id,
             status=excluded.status,
             document=excluded.document`
        )
        .run(
          battle.id,
          battle.repositoryId,
          battle.task,
          battle.baseCommit,
          battle.startedAt,
          battle.finishedAt ?? null,
          battle.winnerSessionId,
          battle.status,
          process.pid,
          JSON.stringify(battle)
        )

      this.db.prepare('DELETE FROM battle_sessions WHERE battle_id=?').run(battle.id)
      const insert = this.db.prepare('INSERT INTO battle_sessions VALUES (?,?,?,?)')

      for (const sessionId of battle.sessionIds) {
        const session = this.getSession(sessionId)

        if (session)
          insert.run(
            battle.id,
            sessionId,
            session.agentId,
            battle.ranking.find((item) => item.sessionId === sessionId)?.rank ?? null
          )
      }
    })
  }

  getBattle(id: string): Battle | undefined {
    return decode<Battle>(this.db.prepare('SELECT document FROM battles WHERE id=?').get(id))
  }

  listBattles(filter: SessionFilter = {}): Page<Battle> {
    const { limit, offset } = pageBounds(filter)
    const conditions: string[] = []
    const values: SQLInputValue[] = []

    if (filter.repository) {
      conditions.push('(b.repository_id=? OR r.name=? OR r.path=?)')
      values.push(filter.repository, filter.repository, filter.repository)
    }

    if (filter.status) {
      conditions.push('b.status=?')
      values.push(filter.status)
    }

    if (filter.from) {
      conditions.push('b.started_at>=?')
      values.push(filter.from)
    }

    if (filter.to) {
      conditions.push('b.started_at<=?')
      values.push(filter.to)
    }

    if (filter.projectType) {
      conditions.push('r.project_type=?')
      values.push(filter.projectType)
    }

    if (filter.agent) {
      conditions.push(
        'EXISTS(SELECT 1 FROM battle_sessions bs WHERE bs.battle_id=b.id AND bs.agent_id=?)'
      )
      values.push(filter.agent)
    }

    if (filter.demo !== undefined) {
      conditions.push(
        'EXISTS(SELECT 1 FROM battle_sessions bs JOIN sessions s ON s.id=bs.session_id WHERE bs.battle_id=b.id AND s.demo=?)'
      )
      values.push(Number(filter.demo))
    }

    if (filter.incomplete !== undefined)
      conditions.push(
        `b.status ${filter.incomplete ? 'IN' : 'NOT IN'} ('preparing','running','verifying','aborted')`
      )

    const clause = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
    const from = ' FROM battles b JOIN repositories r ON r.id=b.repository_id'
    const total = Number(
      this.db.prepare('SELECT COUNT(*) AS total' + from + clause).get(...values)?.total ?? 0
    )

    return {
      items: this.db
        .prepare(
          `SELECT b.document${from}${clause} ORDER BY b.started_at ${filter.order === 'asc' ? 'ASC' : 'DESC'},b.id LIMIT ? OFFSET ?`
        )
        .all(...values, limit, offset)
        .map((row) => decode<Battle>(row)!),
      total,
      limit,
      offset
    }
  }

  leaderboard(filter: SessionFilter = {}): LeaderboardRow[] {
    const { clause, values } = sessionWhere({ ...filter, demo: filter.demo ?? false })

    return this.db
      .prepare(
        `SELECT
           s.agent_id AS agentId,
           COUNT(*) AS runs,
           SUM(CASE
             WHEN s.status='completed'
               AND COALESCE(json_extract(s.document,'$.score.requiredPassed'),1)=1 THEN 1
             ELSE 0
           END) AS successes,
           AVG(s.score) AS averageScore,
           AVG(s.duration_ms) AS averageDurationMs,
           SUM(u.input_tokens) AS inputTokens,
           SUM(u.output_tokens) AS outputTokens,
           SUM(u.total_tokens) AS totalTokens,
           AVG(u.cost_usd) AS averageCostUsd,
           CASE
             WHEN COUNT(u.cost_usd)=0 THEN 'unknown'
             WHEN COUNT(DISTINCT u.cost_type)>1 THEN 'mixed'
             ELSE COALESCE(MAX(u.cost_type),'unknown')
           END AS costType
         FROM sessions s
         JOIN repositories r ON r.id=s.repository_id
         LEFT JOIN usage u ON u.session_id=s.id${clause}
         GROUP BY s.agent_id
         ORDER BY averageScore DESC,successes DESC,s.agent_id`
      )
      .all(...values)
      .map((row) => ({
        agentId: String(row.agentId) as AgentId,
        runs: Number(row.runs),
        successes: Number(row.successes),
        successRate: Number(row.successes) / Number(row.runs),
        averageScore: row.averageScore === null ? null : Number(row.averageScore),
        averageDurationMs: Number(row.averageDurationMs),
        inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
        outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
        totalTokens: row.totalTokens === null ? null : Number(row.totalTokens),
        averageCostUsd: row.averageCostUsd === null ? null : Number(row.averageCostUsd),
        costType: String(row.costType)
      }))
  }

  repositories(): RepositoryRecord[] {
    return this.db
      .prepare('SELECT document FROM repositories ORDER BY name,id')
      .all()
      .map((row) => decode<RepositoryRecord>(row)!)
  }

  recoverIncomplete(): string[] {
    const recovered: string[] = []
    const pending = this.listSessions({ incomplete: true, limit: 500 })

    for (let offset = 0; offset < pending.total; offset += 500)
      for (const session of this.listSessions({ incomplete: true, limit: 500, offset }).items)
        if (session.status !== 'aborted' && !isLive(session.pid)) recovered.push(session.id)

    for (const id of recovered) {
      const session = this.getSession(id)!
      session.status = 'aborted'
      session.finishedAt = new Date().toISOString()
      session.durationMs = Math.max(session.durationMs, Date.now() - Date.parse(session.startedAt))
      session.error = 'Previous RivalCode process stopped before the run completed'
      this.saveSession(session)
    }

    for (const row of this.db
      .prepare(
        "SELECT document,owner_pid FROM battles WHERE status IN ('preparing','running','verifying')"
      )
      .all())
      if (!isLive(Number(row.owner_pid))) {
        const battle = decode<Battle>(row)!
        battle.status = 'aborted'
        battle.finishedAt = new Date().toISOString()
        this.saveBattle(battle)
      }

    return recovered
  }

  close(): void {
    this.db.close()
  }
}
