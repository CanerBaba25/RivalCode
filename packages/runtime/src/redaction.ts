import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseEnv } from 'node:util'
import type { RivalConfig } from '@rivalcode/shared'

const secretName =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential|authorization|cookie|private[_-]?key)(?:$|[_-])/i
const secretProperty =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|passwd|credentials?|private[_-]?key)$|^(?:token|authorization|cookie|set-cookie)$/i
const presets = [
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)?/gi,
  /(?:[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
]

function parseDotenv(text: string): string[] {
  const values = Object.values(parseEnv(text)).filter((value): value is string => Boolean(value))

  // Also cover loaders that expand escaped newlines in quoted dotenv values.
  return values.flatMap((value) => [value, value.replace(/\\n/g, '\n').replace(/\\r/g, '\r')])
}

function replaceSecrets(text: string, pattern: string | RegExp): string {
  const protectedRanges = [...text.matchAll(/\[REDACTED(?:: recursive value)?\]/g)].map((match) => [
    match.index,
    match.index + match[0].length
  ])

  const replace = (...args: unknown[]): string => {
    const match = String(args[0])
    const offset = args[args.length - (typeof args.at(-1) === 'object' ? 3 : 2)] as number

    if (
      !match ||
      protectedRanges.some(([start, end]) => offset >= start! && offset + match.length <= end!)
    )
      return match

    return '[REDACTED]'
  }

  return typeof pattern === 'string'
    ? text.replaceAll(pattern, replace)
    : text.replace(pattern, replace)
}

/** Returns a pure deep redactor; credentials are read only to build in-memory matchers. */
export async function createRedactor(
  root: string,
  config: RivalConfig,
  additionalSecrets: readonly string[] = []
): Promise<(value: unknown) => unknown> {
  // Credential protection is mandatory even when optional privacy settings are relaxed.
  const literals = new Set(additionalSecrets.filter(Boolean))

  for (const [name, value] of Object.entries(process.env))
    if (
      value &&
      (secretName.test(name) ||
        /(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN)/i.test(
          name
        ))
    )
      literals.add(value)

  const files = await readdir(root, { withFileTypes: true }).catch(() => [])

  for (const entry of files)
    if ((entry.isFile() || entry.isSymbolicLink()) && /^\.env(?:\..*)?$/.test(entry.name)) {
      const filename = path.join(root, entry.name)
      const metadata = await stat(filename)

      if (metadata.size > 1024 * 1024)
        throw new Error('A dotenv file exceeds the safe redaction input limit (1 MiB)')

      const file = await readFile(filename)

      for (const value of parseDotenv(file.toString('utf8'))) literals.add(value)
    }

  const values = [...literals].sort((left, right) => right.length - left.length)
  const patterns = [
    ...presets.map((pattern) => new RegExp(pattern.source, pattern.flags)),
    ...config.privacy.customRedactions.map((pattern) => new RegExp(pattern, 'g'))
  ]

  const redactString = (text: string) => {
    let result = text

    for (const literal of values) {
      result = replaceSecrets(result, literal)

      // A capture limit can cut a literal credential at EOF; redact substantial partial prefixes too.
      const candidate = result.lastIndexOf(literal.slice(0, 4))
      if (
        literal.length > 4 &&
        candidate >= 0 &&
        !/\[REDACTED(?:: recursive value)?\]$/.test(result.slice(candidate)) &&
        result.length - candidate < literal.length &&
        literal.startsWith(result.slice(candidate))
      )
        result = result.slice(0, candidate) + '[REDACTED]'
    }

    for (const pattern of patterns) result = replaceSecrets(result, pattern)

    return result
  }

  return (value: unknown): unknown => {
    const ancestors = new WeakSet<object>()

    const visit = (item: unknown, depth: number): unknown => {
      if (typeof item === 'string') return redactString(item)
      if (item === null || typeof item !== 'object') return item
      if (Buffer.isBuffer(item)) return redactString(item.toString('utf8'))
      if (depth > 64 || ancestors.has(item)) return '[REDACTED: recursive value]'

      ancestors.add(item)
      const result = Array.isArray(item)
        ? item.map((entry) => visit(entry, depth + 1))
        : Object.fromEntries(
            Object.entries(item).map(([key, entry]) => [
              key,
              (secretProperty.test(key) || secretName.test(key)) && entry != null
                ? '[REDACTED]'
                : visit(entry, depth + 1)
            ])
          )

      ancestors.delete(item)

      return result
    }

    return visit(value, 0)
  }
}
