/** Incremental, bounded UTF-8 JSONL decoder. Malformed records are observable errors. */
export class JsonlParser {
  private pending = ''
  private discarded = false
  constructor(private readonly maxLineBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 16)
      throw new Error('Invalid JSONL line limit')
  }

  push(chunk: string): unknown[] {
    const records: unknown[] = []
    // Process one segment at a time: never retain an unbounded partial record.
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset)
      const segment = chunk.slice(offset, newline < 0 ? undefined : newline)
      if (!this.discarded) {
        if (Buffer.byteLength(this.pending) + Buffer.byteLength(segment) > this.maxLineBytes) {
          this.pending = ''
          this.discarded = true
          records.push({
            type: 'rivalcode.capture_error',
            message: 'Provider JSONL record exceeded the configured capture limit'
          })
        } else this.pending += segment
      }
      if (newline < 0) break
      if (!this.discarded) this.decode(this.pending, records)
      this.pending = ''
      this.discarded = false
      offset = newline + 1
    }
    return records
  }

  finish(): unknown[] {
    const records: unknown[] = []
    if (!this.discarded) this.decode(this.pending, records)
    this.pending = ''
    this.discarded = false
    return records
  }

  private decode(line: string, output: unknown[]) {
    if (!line.trim()) return
    try {
      output.push(JSON.parse(line))
    } catch {
      output.push({
        type: 'rivalcode.capture_error',
        message: 'Provider emitted a malformed JSONL record'
      })
    }
  }
}
