import assert from 'node:assert/strict'
import test from 'node:test'
import { ThinkingDisplayTracker } from '../lib/engine/thinking-display.js'
import { createTelegramChannel } from '../lib/channels/telegram.js'

test('legacy collapsed mode suppresses Telegram reasoning and preserves final reply in the same topic', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = String(url).split('/').pop()
    const body = JSON.parse(init.body)
    calls.push({ method, body })
    const ok = result => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: 99, username: 'test_bot', is_bot: true })
    if (method === 'getWebhookInfo') return ok({ url: '' })
    if (method === 'getUpdates') return new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason)
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
    if (method === 'sendRichMessage') return Response.json({ ok: false, error_code: 404, description: 'Not Found' })
    if (method === 'sendMessage') return ok({ message_id: 401 })
    return ok(true)
  })
  const channel = createTelegramChannel({ token: 'synthetic-integration-token' }, () => {})
  const tracker = new ThinkingDisplayTracker(error => { throw error }, () => Date.now())
  t.after(async () => { tracker.dispose(); await channel.stop() })
  await channel.start()
  const target = {
    key: 'chat-session', sessionId: 'session', chatId: '-1001:7', channel, turn: 1,
    config: { mode: 'collapsed', minChars: 0 }, isCurrent: () => true,
  }
  tracker.start(target)
  tracker.append(target, 'private reasoning test marker')
  await tracker.finish(target)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.some(call => ['sendMessage', 'sendRichMessage', 'editMessageText'].includes(call.method)), false)

  await channel.send('-1001:7', 'Final answer')
  const sent = calls.filter(call => call.method === 'sendMessage')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.message_thread_id, 7)
  assert.match(sent[0].body.text, /Final answer/)
  assert.ok(calls.every(call => !JSON.stringify(call.body).includes('private reasoning test marker')))
})
