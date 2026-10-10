import { mkdir, realpath, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { FileChange, GitSnapshot } from '@rivalcode/shared'
import { runProcess } from './process.js'

async function git(cwd: string, args: string[], accepted = [0]): Promise<string> {
  const result = await runProcess('git', args, {
    cwd,
    timeoutMs: 60000,
    maxOutputBytes: 64 * 1024 * 1024
  })

  if (!accepted.includes(result.exitCode ?? -1) || result.timedOut || result.truncated)
    throw new Error(
      `git ${args[0]} failed: ${result.stderr.trim() || (result.truncated ? 'output exceeds capture limit' : `exit ${result.exitCode}`)}`
    )

  return result.stdout
}

export async function gitRoot(cwd: string): Promise<string> {
  return path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''))
}

export async function getHead(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
}

export async function getRemote(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['remote', 'get-url', 'origin'])).trim() || undefined
  } catch {
    return undefined
  }
}

export async function assertClean(cwd: string): Promise<void> {
  if (await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    throw new Error(
      'Battle requires a clean Git working tree. Commit or move your changes before running a battle.'
    )

  await getHead(cwd)
}

function parseNameStatus(text: string): FileChange[] {
  const fields = text.split('\0')
  const files: FileChange[] = []

  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!
    const first = fields[index++]

    if (first === undefined) throw new Error('Incomplete Git name-status output')

    const renamed = status.startsWith('R') || status.startsWith('C')
    const name = renamed ? fields[index++] : first

    if (name === undefined) throw new Error('Incomplete Git rename output')

    files.push({
      path: name,
      ...(renamed ? { oldPath: first } : {}),
      status: status[0]!,
      additions: 0,
      deletions: 0,
      binary: false
    })
  }

  return files
}

function parseNumstat(
  text: string
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const fields = text.split('\0')
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>()

  for (let index = 0; index < fields.length && fields[index];) {
    const field = fields[index++]!
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)

    if (firstTab < 0 || secondTab < 0) throw new Error('Invalid Git numstat output')

    const added = field.slice(0, firstTab)
    const removed = field.slice(firstTab + 1, secondTab)
    let name = field.slice(secondTab + 1)

    if (name === '') {
      index++
      name = fields[index++] ?? ''
    }

    stats.set(name, {
      additions: added === '-' ? 0 : Number(added),
      deletions: removed === '-' ? 0 : Number(removed),
      binary: added === '-' || removed === '-'
    })
  }

  return stats
}

async function stageSnapshot(
  execute: (args: string[], stdin?: string) => Promise<string>,
  ignore: string[]
): Promise<void> {
  const paths = await execute([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ':(exclude).rivalcode',
    ...ignore.map((pattern) => `:(exclude,glob)${pattern}`)
  ])

  if (!paths) return

  // Passing exclusions directly to `add` makes Git reject existing ignored directories.
  // Enumerate eligible paths first, then stage literal NUL-separated names including deletions.
  await execute(
    ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
    paths
  )
}

export async function captureDiff(
  cwd: string,
  baseCommit?: string,
  ignore: string[] = []
): Promise<{ diff: string; files: FileChange[] }> {
  const base = baseCommit ?? (await getHead(cwd))

  // Revisions are separate arguments; validate before options to reject option-shaped input.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@{}^~-]*$/.test(base) || base.startsWith('-'))
    throw new Error('Invalid Git base revision')

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rivalcode-diff-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') }

  const execute = async (args: string[], stdin?: string) => {
    const result = await runProcess('git', args, {
      cwd,
      env,
      stdin,
      timeoutMs: 60000,
      maxOutputBytes: 64 * 1024 * 1024
    })

    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error(
        `Unable to capture Git diff: ${result.stderr.trim() || 'capture limit exceeded'}`
      )

    return result.stdout
  }

  try {
    await execute(['read-tree', base])
    await stageSnapshot(execute, ignore)

    const names = parseNameStatus(
      await execute([
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '-z',
        '--find-renames',
        base,
        '--'
      ])
    )

    const statistics = parseNumstat(
      await execute([
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        '--find-renames',
        base,
        '--'
      ])
    )

    const diff = await execute([
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--find-renames',
      base,
      '--'
    ])

    for (const file of names) Object.assign(file, statistics.get(file.path))

    return { diff, files: names }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function captureGit(
  cwd: string,
  baseCommit?: string,
  ignore: string[] = []
): Promise<GitSnapshot> {
  const head = await getHead(cwd)
  const captured = await captureDiff(cwd, baseCommit ?? head, ignore)

  return {
    head,
    status: await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ...captured
  }
}

/** Capture the exact dirty tree through an alternate index without touching HEAD or the real index. */
export async function snapshotCommit(cwd: string, ignore: string[] = []): Promise<string> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'rivalcode-index-'))
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'RivalCode Baseline',
    GIT_AUTHOR_EMAIL: 'baseline@rivalcode.local',
    GIT_COMMITTER_NAME: 'RivalCode Baseline',
    GIT_COMMITTER_EMAIL: 'baseline@rivalcode.local'
  }

  const execute = async (args: string[], stdin?: string) => {
    const result = await runProcess('git', args, {
      cwd,
      env,
      stdin,
      timeoutMs: 60000,
      maxOutputBytes: 1024 * 1024
    })

    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error(`Unable to snapshot dirty baseline: ${result.stderr.trim()}`)

    return result.stdout
  }

  try {
    const head = await getHead(cwd)
    await execute(['read-tree', head])

    await stageSnapshot(execute, ignore)

    const tree = (await execute(['write-tree'])).trim()

    return (
      await execute(['commit-tree', tree, '-p', head, '-m', 'RivalCode local baseline snapshot'])
    ).trim()
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function validateWorktreePath(root: string, target: string): Promise<string> {
  const resolvedRoot = await realpath(root)
  const allowed = path.join(resolvedRoot, '.rivalcode', 'worktrees')
  const resolved = path.resolve(target)
  const relative = path.relative(allowed, resolved)

  if (
    !relative ||
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    throw new Error('Worktree path must be a child of .rivalcode/worktrees')

  // Resolve existing ancestors to stop a symlinked state directory escaping the repository.
  await mkdir(allowed, { recursive: true })
  const actualAllowed = await realpath(allowed)
  const allowedRelative = path.relative(resolvedRoot, actualAllowed)

  if (
    allowedRelative === '..' ||
    allowedRelative.startsWith('..' + path.sep) ||
    path.isAbsolute(allowedRelative)
  )
    throw new Error('Worktree directory escapes the repository')

  const parent = path.dirname(resolved)
  await mkdir(parent, { recursive: true })
  const actualParent = await realpath(parent)
  const parentRelative = path.relative(actualAllowed, actualParent)

  if (
    parentRelative === '..' ||
    parentRelative.startsWith('..' + path.sep) ||
    path.isAbsolute(parentRelative)
  )
    throw new Error('Worktree parent escapes its state directory')

  return resolved
}

export async function createWorktree(root: string, target: string, commit: string): Promise<void> {
  const resolved = await validateWorktreePath(root, target)
  if (!/^[a-fA-F0-9]{40,64}$/.test(commit)) throw new Error('Worktree requires an exact Git commit')

  await git(root, ['worktree', 'add', '--detach', '--', resolved, commit])
}

export async function removeWorktree(root: string, target: string): Promise<void> {
  const resolved = await validateWorktreePath(root, target)
  const actual = await realpath(resolved)
  const allowed = await realpath(path.join(root, '.rivalcode', 'worktrees'))
  const relative = path.relative(allowed, actual)

  if (
    !relative ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error('Worktree resolves outside its owned directory')

  const listed = (await git(root, ['worktree', 'list', '--porcelain', '-z']))
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice(9)))

  if (!listed.includes(resolved)) throw new Error('Refusing to remove an unregistered worktree')

  await git(root, ['worktree', 'remove', '--force', '--', resolved])
}
