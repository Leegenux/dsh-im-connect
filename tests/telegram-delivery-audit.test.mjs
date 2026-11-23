import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImEngine } from '../lib/engine/gateway.js'
import { DeliveryRejected } from '../lib/engine/deferred-delivery.js'
import { SessionMapStore } from '../lib/engine/session-store.js'
import { SeenStore } from '../lib/engine/seen-store.js'
import { createTelegramChannel } from '../lib/channels/telegram.js'

async function fixture(t, { result = { message_id: 123 }, networkFailure = false, rejected = false, ambiguous = false, observerThrows = false, text = 'private answer', seq = 7, paths = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-audit-'))
  const sessionId = 'audit-session'
  const store = new SessionMapStore(join(dir, 'sessions.json'))
  store.upsert('telegram:dm:42', { sessionId, channel: 'telegram', kind: 'dm', chatId: '42', title: 'test', updatedAt: new Date().toISOString() })
  const handlers = {}, events = [], calls = [], logs = []
  const ctx = { on(name, fn) { handlers[name] = fn; return () => {} }, emit(name, event) { events.push([name, event]); if (observerThrows) throw Error('observer'); return handlers[name]?.(event) }, get(name) { return name === 'workspaceFiles' ? { readAll: async () => ({ data: Buffer.from('file bytes').toString('base64'), eof: true, offset: 0 }) } : undefined } }
  const engine = new ImEngine(ctx, store, new SeenStore(join(dir, 'seen.json')), { cwd: dir, provider: 'p', model: 'm', agentPreset: 'standard', mergeTimeoutSecs: 1, permissionPreset: 'danger-full-access' }, line => logs.push(line), undefined, undefined, undefined, undefined, undefined, [0])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').at(-1), body: init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body) })
    if (networkFailure) throw new TypeError('connection lost')
    if (rejected) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 120 } }), { status: 429 })
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const channel = createTelegramChannel({ token: 'fixture-token' }, () => {})
  channel.canDeliverDeferred = () => true
  channel.authorizes = () => true
  engine.register(channel)
  engine.deferred.begin('request-1', sessionId, 'telegram', { chatId: '42', userId: 'user-1', kind: 'dm', text: '' })
  engine.deferred.claim(sessionId, 1, 'request-1')
  if (ambiguous) { engine.deferred.begin('request-2', sessionId, 'telegram', { chatId: '42', userId: 'user-1', kind: 'dm', text: '' }); engine.deferred.claim(sessionId, 1, 'request-2') }
  t.after(async () => { engine.dispose(); await channel.stop(); globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }) })
  const sendDirect = () => engine.processSessionEvent({ id: sessionId, header: { cwd: dir }, events: [{ type: 'deliverables/presented', data: { turn: 1, files: paths.map(path => ({ path })) } }] }, { type: 'assistant/message', seq, surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text }] } } }, { ok: true })
  return { dir, events, calls, logs, handlers, engine, channel, sendDirect, startStream: (initial) => engine.streams.onTextDelta('telegram:42', 'partial', () => channel.beginReply('42', initial), sessionId), send: () => engine.onSessionEvent({ id: sessionId, header: { cwd: dir }, events: [{ type: 'deliverables/presented', data: { turn: 1, files: paths.map(path => ({ path })) } }] }, { type: 'assistant/message', seq, surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text }] } } }), replay: () => { engine.deferred.release(sessionId); engine.deferred.patch('request-1', { status: 'ready', text: 'replay text' }); return engine.recoverDelivery(engine.deferred.list().find(entry => entry.id === 'request-1'), true) } }
}

test('Telegram API fixture reaches the Hermes journal and report', { skip: !process.env.HERMES_AUDIT_TEST_ROOT }, async t => {
  const f = await fixture(t)
  const load = relative => import(pathToFileURL(resolve(process.env.HERMES_AUDIT_TEST_ROOT, relative)))
  const { apply } = await load('src/index.mjs')
  const { readAuditReport } = await load('scripts/audit-report.mjs')
  const disposers = [], listeners = new Map(), pending = []
  const root = join(f.dir, 'audit')
  apply({ on(name, listener) { listeners.set(name, listener) }, effect(factory) { disposers.push(factory()) }, logger: { warn() {} } }, { auditRoot: root })
  try {
    const session = { id: 'audit-session' }
    listeners.get('session/event')(session, { type: 'turn/start', data: { turn: 1 } })
    f.handlers['im/delivery-audit'] = event => { pending.push(listeners.get('im/delivery-audit')(event)) }
    await f.send()
    await Promise.all(pending)
    const initial = readAuditReport(root)
    assert.equal(initial.coverage.complete, true)
    const [delivery] = initial.deliveries
    assert.equal(delivery.outcome, 'acknowledged')
    assert.equal(delivery.platformMessageId, '123')
    assert.equal(delivery.firstGap, null)
    const report = readAuditReport(root, { trace: delivery.traceId })
    assert.deepEqual(report.trace.map(event => event.type), ['turn.started', 'delivery.created', 'delivery.handed_off', 'delivery.result'])
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
})

test('live final Telegram text reports only actual receipt and no content or route', async t => {
  const f = await fixture(t); await f.send()
  assert.equal(f.calls.length, 1, JSON.stringify(f.logs))
  assert.equal(f.calls[0].method, 'sendRichMessage')
  assert.deepEqual(f.events.map(([name, e]) => [name, e.phase]), [['im/delivery-audit', 'created'], ['im/delivery-audit', 'handed_off'], ['im/delivery-audit', 'result']])
  const values = f.events.map(([, e]) => e)
  assert.equal(new Set(values.map(e => e.deliveryId)).size, 1)
  assert.deepEqual(values[2], { sessionId: 'audit-session', turnId: 1, requestId: 'request-1', deliveryId: values[0].deliveryId, phase: 'result', outcome: 'acknowledged', platformMessageId: '123' })
  assert.ok(!JSON.stringify(values).includes('private answer'))
  assert.deepEqual(Object.keys(values[0]).sort(), ['deliveryId', 'phase', 'requestId', 'sessionId', 'turnId'])
})

test('missing receipt and lost response are unknown', async t => {
  for (const options of [{ result: {} }, { networkFailure: true }]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, options); await f.send()
      assert.equal(f.events.at(-1)[1].outcome, 'unknown')
      assert.equal(f.calls.length, 1)
    })
  }
})

test('explicit Telegram rejection is failed and split messages get separate delivery IDs', async t => {
  await t.test('rejected', async t => {
    const f = await fixture(t, { rejected: true }); await f.send()
    assert.equal(f.events.at(-1)[1].outcome, 'failed')
    assert.equal(f.calls.length, 1)
  })
  await t.test('split', async t => {
    const f = await fixture(t, { text: 'x'.repeat(5000) }); await f.send()
    assert.equal(f.calls.length, 2)
    const results = f.events.filter(([, e]) => e.phase === 'result').map(([, e]) => e)
    assert.equal(results.length, 2)
    assert.equal(new Set(results.map(e => e.deliveryId)).size, 2)
    assert.ok(results.every(e => e.outcome === 'acknowledged'))
  })
})

test('stream final uses exact final edit receipt and stays unknown without complete evidence', async t => {
  await t.test('final edit receipt', async t => {
    const f = await fixture(t); await f.startStream(); await f.send()
    assert.equal(f.calls.at(-1).method, 'editMessageText')
    assert.equal(f.events.at(-1)[1].outcome, 'acknowledged')
    assert.equal(f.events.at(-1)[1].platformMessageId, '123')
  })
  await t.test('already verified exact final requires no new edit', async t => {
    const f = await fixture(t); await f.startStream('private answer'); await f.send()
    assert.equal(f.calls.length, 1)
    assert.equal(f.events.at(-1)[1].outcome, 'acknowledged')
  })
  await t.test('missing edit receipt', async t => {
    const f = await fixture(t, { result: {} }); await f.startStream(); await f.send()
    assert.equal(f.events.at(-1)[1].outcome, 'unknown')
  })
  await t.test('multi-chunk final', async t => {
    const f = await fixture(t, { text: 'x'.repeat(5000) }); await f.startStream(); await f.send()
    assert.ok(f.calls.length >= 3)
    assert.equal(f.events.at(-1)[1].outcome, 'unknown')
  })
})

test('session event sequence stabilizes chunk identity across independent runs', async t => {
  const ids = []
  for (let i = 0; i < 2; i++) await t.test(`run ${i}`, async t => {
    const f = await fixture(t, { text: 'x'.repeat(5000) }); await f.send()
    ids.push(f.events.filter(([, e]) => e.phase === 'result').map(([, e]) => e.deliveryId))
  })
  assert.deepEqual(ids[0], ids[1])
  assert.notEqual(ids[0][0], ids[0][1])
})

test('attachment audit reflects actual Telegram document receipts', async t => {
  await t.test('two attachments have separate IDs and no filename', async t => {
    const f = await fixture(t, { text: '', paths: ['secret-name.txt', 'second.txt'] }); await f.send()
    assert.deepEqual(f.calls.map(c => c.method), ['sendDocument', 'sendDocument'])
    const results = f.events.filter(([, e]) => e.phase === 'result').map(([, e]) => e)
    assert.equal(results.length, 2)
    assert.notEqual(results[0].deliveryId, results[1].deliveryId)
    assert.ok(results.every(e => e.outcome === 'acknowledged' && e.platformMessageId === '123'))
    assert.ok(!JSON.stringify(f.events).includes('secret-name'))
  })
  await t.test('missing receipt is unknown', async t => {
    const f = await fixture(t, { text: '', paths: ['a.txt'], result: {} }); await f.send()
    assert.equal(f.events.at(-1)[1].outcome, 'unknown')
  })
  await t.test('lost response is unknown', async t => {
    const f = await fixture(t, { text: '', paths: ['a.txt'], networkFailure: true }); await f.send()
    assert.equal(f.events.at(-1)[1].outcome, 'unknown')
    assert.equal(f.calls.filter(c => c.method === 'sendDocument').length, 1)
  })
  await t.test('observer failure does not prevent upload', async t => {
    const f = await fixture(t, { text: '', paths: ['a.txt'], observerThrows: true }); await f.send()
    assert.equal(f.calls.filter(c => c.method === 'sendDocument').length, 1)
    assert.equal(f.events.at(-1)[1].outcome, 'acknowledged')
  })
  await t.test('mismatched journal channel withholds attachment attribution', async t => {
    const f = await fixture(t, { text: '', paths: ['a.txt'] })
    const turnEntries = f.engine.deferred.turnEntries.bind(f.engine.deferred)
    f.engine.deferred.turnEntries = (...args) => turnEntries(...args).map(entry => ({ ...entry, channelId: 'other' }))
    await f.sendDirect()
    assert.equal(f.calls.filter(c => c.method === 'sendDocument').length, 1)
    assert.deepEqual(f.events, [])
  })
  await t.test('ambiguous attribution emits no events', async t => {
    const f = await fixture(t, { text: '', paths: ['a.txt'], ambiguous: true }); await f.send()
    assert.equal(f.calls.filter(c => c.method === 'sendDocument').length, 1)
    assert.deepEqual(f.events, [])
  })
})

test('replay audit requires an exact single request and known turn', async t => {
  await t.test('platform receipt', async t => {
    const f = await fixture(t); await f.replay()
    assert.equal(f.calls.length, 1)
    assert.equal(f.events.at(-1)[1].outcome, 'acknowledged')
    assert.equal(f.events.at(-1)[1].platformMessageId, '123')
    assert.equal(f.events.at(-1)[1].requestId, 'request-1')
  })
  await t.test('ambiguous request', async t => {
    const f = await fixture(t, { ambiguous: true }); await f.replay()
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.events, [])
  })
  await t.test('missing turn', async t => {
    const f = await fixture(t); f.engine.deferred.patch('request-1', { turn: undefined }); await f.replay()
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.events, [])
  })
  await t.test('observer failure does not change replay settlement', async t => {
    const f = await fixture(t, { observerThrows: true }); await f.replay()
    assert.equal(f.engine.deferred.list()[0].status, 'sent')
    assert.equal(f.events.at(-1)[1].outcome, 'acknowledged')
  })
  await t.test('a definite rejection and later acknowledgement have distinct attempts', async t => {
    const f = await fixture(t)
    const send = f.channel.sendWithReceipt.bind(f.channel)
    let first = true
    f.channel.sendWithReceipt = async (...args) => {
      if (first) { first = false; throw new DeliveryRejected('fixture rejection') }
      return send(...args)
    }
    await f.replay()
    assert.equal(f.engine.deferred.list()[0].status, 'ready')
    await f.replay()
    const results = f.events.filter(([, e]) => e.phase === 'result').map(([, e]) => e)
    assert.deepEqual(results.map(e => e.outcome), ['failed', 'acknowledged'])
    assert.equal(results[0].deliveryId, results[1].deliveryId)
    assert.notEqual(results[0].attemptId, results[1].attemptId)
    for (const result of results) {
      const phases = f.events.map(([, e]) => e).filter(e => e.attemptId === result.attemptId).map(e => e.phase)
      assert.deepEqual(phases, ['created', 'handed_off', 'result'])
    }
    assert.equal(f.calls.length, 1)
  })
  await t.test('mismatched journal channel withholds attribution', async t => {
    const f = await fixture(t)
    const turnEntries = f.engine.deferred.turnEntries.bind(f.engine.deferred)
    f.engine.deferred.turnEntries = (...args) => turnEntries(...args).map(entry => ({ ...entry, channelId: 'other' }))
    await f.replay()
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.events, [])
  })
  await t.test('lost response', async t => {
    const f = await fixture(t, { networkFailure: true }); await f.replay()
    assert.equal(f.events.at(-1)[1].outcome, 'unknown')
    assert.equal(f.engine.deferred.list()[0].status, 'unknown')
  })
})

test('ambiguous requests do not emit audit and observer errors do not stop sending', async t => {
  await t.test('ambiguous', async t => { const f = await fixture(t, { ambiguous: true }); await f.send(); assert.equal(f.calls.length, 1); assert.deepEqual(f.events, []) })
  await t.test('throwing observer', async t => { const f = await fixture(t, { observerThrows: true }); await f.send(); assert.equal(f.calls.length, 1); assert.equal(f.events.at(-1)[1].outcome, 'acknowledged') })
})
