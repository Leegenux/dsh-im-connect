import assert from 'node:assert/strict'
import test from 'node:test'
import { createTelegramChannel } from '../lib/channels/telegram.js'
import { ReplyStreamHub } from '../lib/engine/reply-stream.js'
import { describeToolCall } from '../lib/engine/status-line.js'

const head = '✅ 第 20 步 · pwsh · 257ms — '
const detail = describeToolCall('pwsh', { command: `$other='../hermes-parity-implementation'; Copy-Item "$other/test/file"` })
const status = head + detail

async function withStream(run, { rejectRich = false } = {}) {
  const original = globalThis.fetch
  const calls = []
  const edit = Promise.withResolvers()
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop()
    const payload = JSON.parse(init.body)
    calls.push({ method, payload })
    if (method === 'editMessageText') {
      if (rejectRich && payload.rich_message) return Response.json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, { status: 400 })
      edit.resolve(payload)
    }
    return Response.json({ ok: true, result: { message_id: 5 } })
  }
  try {
    const channel = createTelegramChannel({ token: 'test-token' }, () => {})
    await run(channel, calls, edit.promise)
  } finally {
    globalThis.fetch = original
  }
}

test('tool preview is a native code node and replaces the plain opening status', { timeout: 3000 }, async () => {
  await withStream(async (channel, calls, edit) => {
    const hub = new ReplyStreamHub()
    const key = '123:3771'
    await hub.onStatus(key, status, () => channel.beginReply(key, hub.statusOf(key)), 'session', head.length)
    const result = await Promise.race([edit, new Promise(resolve => setTimeout(() => resolve(null), 1000))])
    assert.equal(calls[0].payload.text, status)
    assert.deepEqual(result?.rich_message, { blocks: [{ type: 'paragraph', text: [head, { type: 'code', text: detail }] }] })
    assert.equal(result.message_id, 5)
    const { stream } = await hub.take(key, 'session')
    assert.deepEqual(await stream.finishWithReceipt('**finished**'), { platformMessageId: '5' })
    assert.deepEqual(calls.at(-1).payload.rich_message, { markdown: '**finished**' })
  })
})

test('the tool preview and rich streamed body can share a message', { timeout: 3000 }, async () => {
  await withStream(async (channel, calls, edit) => {
    const stream = await channel.beginReply('123')
    const command = 'Write-Output "a`$b & <x> _ 😀"'
    await stream.setStatus(head + command, head.length)
    await stream.update('**body**\nsecond line')
    const result = await edit
    const [statusLine, body] = result.rich_message.markdown.split('\n\n')
    assert.equal(body, '**body**  \nsecond line')
    assert.equal(statusLine.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))), `${head}<code>${command}</code>`)
    assert.ok(statusLine.includes('&#36;') && statusLine.includes('&#96;'))
    await stream.finish('done')
    assert.equal(calls.length, 3)
  })
})

test('a rejected rich status edit falls back to literal plain text on the same message', { timeout: 3000 }, async () => {
  await withStream(async (channel, calls, edit) => {
    const stream = await channel.beginReply('123')
    await stream.setStatus(status, head.length)
    const result = await edit
    assert.equal(result.text, status)
    assert.equal(result.message_id, 5)
    assert.equal(result.rich_message, undefined)
    assert.deepEqual(calls.map(call => call.method), ['sendMessage', 'editMessageText', 'editMessageText'])
    await stream.finish('done')
  }, { rejectRich: true })
})
