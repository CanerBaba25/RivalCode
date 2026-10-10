import { Icon, State, Empty, useApi } from '../lib/common.js'
import { useState, useEffect, useMemo } from 'react'
import type { Session, FileChange } from '@rivalcode/shared'

export interface DiffFile {
  path: string
  lines: {
    text: string
    kind: 'add' | 'delete' | 'context' | 'header' | 'meta'
    old?: number
    next?: number
  }[]
}

function gitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value

  const bytes: number[] = []
  const encoder = new TextEncoder()
  const escapes: Record<string, string> = {
    a: '\u0007',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\u000b',
    f: '\f',
    r: '\r'
  }

  // Git quotes UTF-8 bytes with octal escapes rather than JSON Unicode escapes.
  for (const token of value.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/g)) {
    const escaped = token[1]
    if (escaped && /^[0-7]{1,3}$/.test(escaped)) bytes.push(parseInt(escaped, 8))
    else bytes.push(...encoder.encode(escaped ? (escapes[escaped] ?? escaped) : token[2]))
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | undefined
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const match = /^diff --git (?:"(?:\\.|[^"\\])*"|a\/.+?) ("(?:\\.|[^"\\])*"|b\/.+)$/.exec(text)
      current = { path: gitPath(match?.[1] ?? text.slice(11)).replace(/^b\//, ''), lines: [] }
      files.push(current)
      inHunk = false
      continue
    }
    if (!current) continue
    const fileHeader = inHunk ? null : /^\+\+\+ ("(?:\\.|[^"\\])*"|[^\t]+)(?:\t.*)?$/.exec(text)
    if (fileHeader?.[1] && fileHeader[1] !== '/dev/null')
      current.path = gitPath(fileHeader[1]).replace(/^b\//, '')
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = Number.isSafeInteger(oldLine) && Number.isSafeInteger(newLine)
      current.lines.push({ text, kind: 'header' })
    } else if (inHunk && text.startsWith('+'))
      current.lines.push({ text: text.slice(1), kind: 'add', next: newLine++ })
    else if (inHunk && text.startsWith('-'))
      current.lines.push({ text: text.slice(1), kind: 'delete', old: oldLine++ })
    else if (inHunk && text.startsWith(' '))
      current.lines.push({ text: text.slice(1), kind: 'context', old: oldLine++, next: newLine++ })
    else if (text) current.lines.push({ text, kind: 'meta' })
  }
  return files
}
export function HighlightCode({ text }: { text: string }) {
  const tokens = text.split(
    /(\b(?:const|let|var|return|if|else|import|from|export|class|function|async|await|new|throw|try|catch|true|false|null|undefined|def|self|public|private|interface|type)\b|"[^"\n]*"|'[^'\n]*'|\/\/.*$|\b\d+\b)/g
  )
  return (
    <>
      {tokens.map((token, index) => (
        <span
          key={index}
          className={
            /^['"]/.test(token)
              ? 'syntax-string'
              : /^\/\//.test(token)
                ? 'syntax-comment'
                : /^(?:const|let|var|return|if|else|import|from|export|class|function|async|await|new|throw|try|catch|true|false|null|undefined|def|self|public|private|interface|type)$/.test(
                      token
                    )
                  ? 'syntax-keyword'
                  : /^\d+$/.test(token)
                    ? 'syntax-number'
                    : undefined
          }
        >
          {token}
        </span>
      ))}
    </>
  )
}
export function DiffViewer({ session, selectedPath }: { session: Session; selectedPath?: string }) {
  const query = useApi<{ diff: string; fidelity: string; files: FileChange[] }>(
    `/api/sessions/${session.id}/diff`
  )
  const [filter, setFilter] = useState('')
  const [file, setFile] = useState(selectedPath ?? '')
  const [hideContext, setHideContext] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const parsed = useMemo(() => parseDiff(query.data?.diff ?? ''), [query.data?.diff])
  useEffect(() => {
    if (selectedPath) setFile(selectedPath)
  }, [selectedPath])
  const paths = [
    ...new Set([...session.files.map((f) => f.path), ...parsed.map((f) => f.path)])
  ].filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
  const shown = parsed.filter(
    (entry) =>
      (!file || entry.path === file) && entry.path.toLowerCase().includes(filter.toLowerCase())
  )
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  return (
    <>
      <div className="diff-toolbar">
        <span className="mini-label">SAVED FINAL DIFF</span>
        <p>Compared to the captured baseline. Individual edit snapshots are unavailable.</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={hideContext}
            onChange={(event) => setHideContext(event.target.checked)}
          />
          Collapse unchanged lines
        </label>
      </div>
      <State {...query} />
      {query.data &&
        (paths.length || query.data.diff ? (
          <div className="diff-layout">
            <aside className="files-sidebar" aria-label="Changed files">
              <label>
                Filter files
                <input
                  value={filter}
                  placeholder="Search file path…"
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <button
                className={`file-button ${file === '' ? 'selected' : ''}`}
                onClick={() => setFile('')}
              >
                All changed files <span>{session.files.length}</span>
              </button>
              {paths.map((path) => {
                const change = session.files.find((f) => f.path === path)
                return (
                  <button
                    className={`file-button ${file === path ? 'selected' : ''}`}
                    key={path}
                    onClick={() => setFile(path)}
                  >
                    <span title={path}>{path}</span>
                    <span className="file-stat">
                      <span className="text-teal">+{change?.additions ?? 0}</span>
                      <span className="text-coral">−{change?.deletions ?? 0}</span>
                    </span>
                  </button>
                )
              })}
            </aside>
            <div className="diff-content">
              {shown.map((entry) => {
                const change = session.files.find((f) => f.path === entry.path)
                return (
                  <article className="diff-file" key={entry.path}>
                    <button
                      className="diff-file-heading"
                      aria-expanded={!collapsed.has(entry.path)}
                      onClick={() => toggle(entry.path)}
                    >
                      <Icon name="code" size={16} />
                      <strong>{entry.path}</strong>
                      <span className="file-stat">
                        <span className="text-teal">
                          +{change?.additions ?? entry.lines.filter((l) => l.kind === 'add').length}
                        </span>
                        <span className="text-coral">
                          −
                          {change?.deletions ??
                            entry.lines.filter((l) => l.kind === 'delete').length}
                        </span>
                      </span>
                      <span>{collapsed.has(entry.path) ? '+' : '−'}</span>
                    </button>
                    {!collapsed.has(entry.path) && (
                      <div className="diff-code">
                        <table aria-label={`Diff for ${entry.path}`}>
                          <tbody>
                            {entry.lines
                              .filter((line) => !hideContext || line.kind !== 'context')
                              .map((line, index) => (
                                <tr key={index} className={`diff-line ${line.kind}`}>
                                  <td className="line-number">{line.old ?? ''}</td>
                                  <td className="line-number">{line.next ?? ''}</td>
                                  <td className="line-sign">
                                    {line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''}
                                  </td>
                                  <td>
                                    <pre>
                                      <HighlightCode text={line.text} />
                                    </pre>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </article>
                )
              })}
              {!shown.length && (
                <Empty
                  title={file ? 'No textual patch for this file' : 'No files match this filter'}
                >
                  <p>
                    {session.files.find((f) => f.path === file)?.binary
                      ? 'Binary files have no textual diff.'
                      : 'The saved patch does not contain a textual diff for this selection.'}
                  </p>
                </Empty>
              )}
            </div>
          </div>
        ) : (
          <Empty title="No saved changes">
            <p>This session did not produce a final patch.</p>
          </Empty>
        ))}
    </>
  )
}
