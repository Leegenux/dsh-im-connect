import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TopicTitleOutbox } from '../lib/engine/topic-title-outbox.js'

test('corrupt outbox and failed writes fail closed without accepting new work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'topic-outbox-error-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'pending.json')
  writeFileSync(file, '{broken')
  const corrupt = new TopicTitleOutbox(file)
  assert.throws(() => corrupt.put('x', { channelId: 'x', chatId: 'x', sessionId: 'x', name: 'x' }))
  const unwritable = new TopicTitleOutbox(join(dir, 'missing', 'file', 'pending.json'))
  writeFileSync(join(dir, 'missing'), 'not a directory')
  assert.throws(() => unwritable.put('x', { channelId: 'x', chatId: 'x', sessionId: 'x', name: 'x' }))
  assert.equal(unwritable.get('x'), undefined)
})

test('pending topic titles persist across instances and stale acknowledgements cannot delete newer names', t => {
  const dir = mkdtempSync(join(tmpdir(), 'topic-outbox-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'pending.json')
  const outbox = new TopicTitleOutbox(file)
  const first = outbox.put('telegram:-100:20', { channelId: 'telegram', chatId: '-100:20', sessionId: 's1', name: 'first' })
  const second = outbox.put('telegram:-100:20', { channelId: 'telegram', chatId: '-100:20', sessionId: 's1', name: 'second' })
  assert.equal(outbox.remove('telegram:-100:20', first.id), false)
  const reopened = new TopicTitleOutbox(file)
  assert.equal(reopened.get('telegram:-100:20').name, 'second')
  assert.equal(reopened.remove('telegram:-100:20', second.id), true)
  assert.equal(new TopicTitleOutbox(file).get('telegram:-100:20'), undefined)
})
