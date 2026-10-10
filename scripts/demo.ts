import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initRepository, runProcess } from '@rivalcode/runtime'
import { runAgent, runBattle } from '@rivalcode/core'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.join(workspace, '.demo', 'repo-' + randomUUID().slice(0, 8))
const buggyMath = 'export function add (a, b) {\n  return a - b; /* RIVALCODE_DEMO_BUG */\n}\n'

await mkdir(path.join(repo, 'src'), { recursive: true })
await mkdir(path.join(repo, 'test'))
await writeFile(path.join(repo, 'src', 'math.js'), buggyMath, { flag: 'wx' })
await writeFile(
  path.join(repo, 'package.json'),
  JSON.stringify({
    name: 'rivalcode-demo',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' }
  }),
  { flag: 'wx' }
)
await writeFile(
  path.join(repo, 'README.md'),
  '# Demo Agent fixture\n\nAn intentional addition bug, repaired and independently verified without a paid model.\n',
  { flag: 'wx' }
)
await writeFile(
  path.join(repo, 'test', 'math.test.js'),
  `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from '../src/math.js'

test('add combines two positive numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('add works with negative numbers', () => {
  assert.equal(add(-2, 3), 1)
})
`,
  { flag: 'wx' }
)
await writeFile(path.join(repo, '.gitignore'), '.rivalcode/\n')

async function git(args: string[]) {
  const result = await runProcess('git', args, { cwd: repo, timeoutMs: 10000 })
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Demo repository preparation failed')
}

await git(['init', '-b', 'main'])
const config = await initRepository(repo)
config.verification = {
  runBaseline: true,
  commands: [{ id: 'test', executable: process.execPath, args: ['--test'], required: true }]
}
await writeFile(path.join(repo, 'rivalcode.config.json'), JSON.stringify(config, null, 2))
await git(['add', '.'])
await git([
  '-c',
  'user.name=RivalCode Demo',
  '-c',
  'user.email=demo@localhost',
  'commit',
  '-m',
  'Add intentionally failing demo task'
])

const task = 'Fix the marked addition bug and verify the existing tests.'
const single = await runAgent({
  root: repo,
  agent: 'demo',
  task,
  demo: true,
  config,
  onProgress: console.log
})
if (single.status !== 'completed') throw new Error(single.error ?? 'Demo single run failed')

// Restore only the fixture we just created so the battle starts at the same bug.
await writeFile(path.join(repo, 'src', 'math.js'), buggyMath)
const battle = await runBattle({
  root: repo,
  agents: ['demo'],
  task,
  demo: true,
  config,
  onProgress: console.log
})
if (battle.status !== 'completed' || !battle.winnerSessionId) throw new Error('Demo battle failed')

console.log(`\nDemo repository: ${repo}\nSession: ${single.id}\nBattle: ${battle.id}`)
console.log(`Open it with: pnpm dev:cli --repo "${repo}" dashboard`)
