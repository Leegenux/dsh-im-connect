import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileAtomicSync } from './atomic-file.js'

export interface TopicTitlePending {
  id: string
  channelId: string
  chatId: string
  sessionId: string
  name: string
}

/** Durable, bounded latest-intent per route; never evict unconfirmed work. */
export class TopicTitleOutbox {
  private entries: Record<string, TopicTitlePending> = Object.create(null) as Record<string, TopicTitlePending>
  private readonly loadError?: Error

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid topic outbox')
      for (const [key, item] of Object.entries(value)) {
        if (!item || typeof item !== 'object' || !['id', 'channelId', 'chatId', 'sessionId', 'name'].every(field => typeof (item as Record<string, unknown>)[field] === 'string')) throw new Error('invalid topic outbox entry')
        this.entries[key] = item as TopicTitlePending
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = error instanceof Error ? error : new Error(String(error))
    }
  }

  list(): Array<[string, TopicTitlePending]> { this.check(); return Object.entries(this.entries) }
  get(key: string): TopicTitlePending | undefined { this.check(); return this.entries[key] }
  put(key: string, value: Omit<TopicTitlePending, 'id'>): TopicTitlePending {
    this.check()
    if (!this.entries[key] && Object.keys(this.entries).length >= 2000) throw new Error('topic title outbox full')
    const entry = { ...value, id: randomUUID() }
    this.commit({ ...this.entries, [key]: entry })
    return entry
  }
  remove(key: string, id: string): boolean {
    this.check()
    if (this.entries[key]?.id !== id) return false
    const next = { ...this.entries }
    delete next[key]
    this.commit(next)
    return true
  }
  private check(): void { if (this.loadError) throw this.loadError }
  private commit(next: Record<string, TopicTitlePending>): void {
    if (this.file) writeFileAtomicSync(this.file, `${JSON.stringify(next)}\n`, 0o600)
    this.entries = next
  }
}
