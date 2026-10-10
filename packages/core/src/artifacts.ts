import { randomUUID } from 'node:crypto'
import { lstat, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function writeArtifact(
  directory: string,
  filename: string,
  content: string | Uint8Array
) {
  const info = await lstat(directory)
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    path.relative(directory, await realpath(directory)) !== ''
  )
    throw new Error('Refusing an unsafe session artifact directory')

  if (!/^[a-z]+\.(?:json|diff)$/.test(filename))
    throw new Error('Invalid session artifact filename')

  const target = path.join(directory, filename)
  try {
    const existing = await lstat(target)
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error('Refusing an unsafe session artifact file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`)
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })

  try {
    // Replace the directory entry instead of writing through an existing link.
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
