// Embedded so packed CLI distributions need no source-tree script paths.
export const demoScript = String.raw`import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
let sequence = 0
const emit = (type, payload = {}) =>
  process.stdout.write(
    JSON.stringify({
      demo: true,
      id: 'demo-' + ++sequence,
      type,
      timestamp: new Date().toISOString(),
      payload
    }) + '\n'
  )
const cwd = process.env.RIVALCODE_DEMO_CWD
if (!cwd) {
  emit('error', { message: 'Demo workspace missing' })
  process.exit(1)
}
emit('session_started')
try {
  const target = join(cwd, 'src', 'math.js')
  const before = await readFile(target, 'utf8').catch(() => null)
  if (before !== null && before.includes('/* RIVALCODE_DEMO_BUG */')) {
    await writeFile(
      target,
      before.replace('return a - b; /* RIVALCODE_DEMO_BUG */', 'return a + b;')
    )
    emit('file_changed', { path: 'src/math.js' })
  } else {
    await writeFile(
      join(cwd, 'rivalcode-demo-result.txt'),
      'RivalCode Demo Agent completed an actual deterministic edit.\n'
    )
    emit('file_changed', { path: 'rivalcode-demo-result.txt' })
  }
  emit('command_started', { command: 'node --test', tool: 'shell' })
  const verification = spawnSync(process.execPath, ['--test'], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024
  })
  emit('command_finished', {
    command: 'node --test',
    exitCode: verification.status,
    failed: verification.status !== 0
  })
  emit('assistant_output', {
    text: 'Demo Agent changed a file and ran node --test. No provider inference or usage is simulated.'
  })
  emit('session_finished', { failed: false })
} catch (error) {
  emit('error', { message: error.message })
  process.exitCode = 1
}
`
