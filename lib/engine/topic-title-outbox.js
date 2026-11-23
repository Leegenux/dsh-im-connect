import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic-file.js';
/** Durable, bounded latest-intent per route; never evict unconfirmed work. */
export class TopicTitleOutbox {
    file;
    entries = Object.create(null);
    loadError;
    constructor(file) {
        this.file = file;
        if (!file)
            return;
        try {
            const value = JSON.parse(readFileSync(file, 'utf8'));
            if (!value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('invalid topic outbox');
            for (const [key, item] of Object.entries(value)) {
                if (!item || typeof item !== 'object' || !['id', 'channelId', 'chatId', 'sessionId', 'name'].every(field => typeof item[field] === 'string'))
                    throw new Error('invalid topic outbox entry');
                this.entries[key] = item;
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                this.loadError = error instanceof Error ? error : new Error(String(error));
        }
    }
    list() { this.check(); return Object.entries(this.entries); }
    get(key) { this.check(); return this.entries[key]; }
    put(key, value) {
        this.check();
        if (!this.entries[key] && Object.keys(this.entries).length >= 2000)
            throw new Error('topic title outbox full');
        const entry = { ...value, id: randomUUID() };
        this.commit({ ...this.entries, [key]: entry });
        return entry;
    }
    remove(key, id) {
        this.check();
        if (this.entries[key]?.id !== id)
            return false;
        const next = { ...this.entries };
        delete next[key];
        this.commit(next);
        return true;
    }
    check() { if (this.loadError)
        throw this.loadError; }
    commit(next) {
        if (this.file)
            writeFileAtomicSync(this.file, `${JSON.stringify(next)}\n`, 0o600);
        this.entries = next;
    }
}
//# sourceMappingURL=topic-title-outbox.js.map