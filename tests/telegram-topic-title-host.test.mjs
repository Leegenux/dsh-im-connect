import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { ImEngine } from '../lib/engine/gateway.js'
import { SessionMapStore } from '../lib/engine/session-store.js'
import { SeenStore } from '../lib/engine/seen-store.js'

const hostRoot = process.env.DSH_TOPIC_TITLE_HOST_ROOT
const tick = () => new Promise(resolve => setImmediate(resolve))

// This contract test takes an explicitly selected built host so an older host is never
// reported as passing the new cross-package behavior.
test('Telegram topic edits reach the real DSH title projection without launching a turn', {
  skip: !hostRoot && 'Set DSH_TOPIC_TITLE_HOST_ROOT to the built candidate host checkout',
}, async t => {
  const load = relative => import(pathToFileURL(join(hostRoot, relative, 'lib', 'index.js')).href)
  const [{ Context }, { default: SessionStore, KNOWN_SESSION_EVENT_TYPES }, { default: AgentRegistry },
    { default: ProjectionRegistry }, { default: TitleService }, format] = await Promise.all([
    load('vendor/cordis'), load('packages/core/session'), load('packages/core/agent'),
    load('packages/session/session-projection'), load('packages/session/session-title'),
    load('packages/session/session-format-v3-to-v4'),
  ])
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 256 })

  const dir = mkdtempSync(join(tmpdir(), 'im-topic-title-host-'))
  const session = ctx.sessions.create('im-topic-title-host', { meta: { cwd: dir } })
  const channelId = 'test-telegram'
  const chatId = '-1002000000000:17'
  const store = new SessionMapStore(join(dir, 'sessions.json'))
  store.upsert(`${channelId}:group:${chatId}`, { sessionId: session.id, channel: channelId, kind: 'group', chatId, title: 'Original', updatedAt: new Date().toISOString() })
  const engine = new ImEngine(ctx, store, new SeenStore(join(dir, 'seen.json')), {
    cwd: dir, provider: 'test', model: 'test', agentPreset: '', mergeTimeoutSecs: 1, permissionPreset: '', topicNaming: 'follow',
  }, () => {})
  t.after(() => { engine.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const outbound = []
  let edited
  engine.register({
    id: channelId, label: 'Telegram', maxMessageLength: 4000,
    start() {}, stop() {}, send: async () => {}, setMessageHandler() {},
    setTopicEditHandler(callback) { edited = callback },
    async renameTopic(_route, title) { outbound.push(title); return true },
  })
  assert.equal(typeof ctx.sessionTitle.syncTelegramTopicTitle, 'function')
  const edit = async title => { await edited(chatId, title, { forumGroup: true }); await tick() }
  await edit('Telegram title one')
  assert.equal(ctx.sessionProjections.snapshot(session).values.title, 'Telegram title one')
  assert.deepEqual(outbound, [])
  assert.equal(session.snapshotEvents().some(event => event.type === 'turn/start'), false)

  await edit('Telegram title two')
  assert.equal(ctx.sessionProjections.snapshot(session).values.title, 'Telegram title two')
  assert.deepEqual(ctx.sessionTitle.get(session).source, { kind: 'user', origin: 'telegram' })
  const artifact = {
    header: { version: 4, id: session.id, createdAt: session.header.createdAt, isSeeded: false, delegationDepth: 0, cwd: dir },
    events: session.snapshotEvents(), inheritedEventCount: 0,
  }
  const restored = format.restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES)
  assert.deepEqual(restored.events.findLast(event => event.type === 'session/title').data.source, { kind: 'user', origin: 'telegram' })
  const previousHost = process.env.DSH_TOPIC_TITLE_PREVIOUS_HOST_ROOT
  if (previousHost) {
    const previous = relative => import(pathToFileURL(join(previousHost, relative, 'lib', 'index.js')).href)
    const [oldFormat, oldSession, oldTitle] = await Promise.all([
      previous('packages/session/session-format-v3-to-v4'), previous('packages/core/session'), previous('packages/session/session-title'),
    ])
    const oldRestored = oldFormat.restoreReleasedV4Artifact(artifact, oldSession.KNOWN_SESSION_EVENT_TYPES)
    assert.equal(oldTitle.foldSessionTitle(oldRestored.events).title, 'Telegram title two')
  }

  ctx.sessionTitle.rename(session, 'DSH manual title')
  await tick()
  await edit('Telegram title three')
  assert.equal(ctx.sessionProjections.snapshot(session).values.title, 'DSH manual title')
  assert.deepEqual(outbound, [])
})
