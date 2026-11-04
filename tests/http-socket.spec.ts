/**
 * Drives the management routes over a real loopback socket with a real Store on SQLite: the request, the route table, the
 * Engine and the database are the shipped ones, while only the Cordis host wrapper and the services no Ticket route reads
 * are stood in for. The panel's own tests cover the same route through its client instead.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Engine, type Assessor, type Executor } from '../src/core/index.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { registerHttp } from '../src/app/http.ts'
import { testDeployment } from './fixtures/deployment.ts'

const directory = mkdtempSync(join(tmpdir(), 'e2e-stop-'))
const store = new Store(join(directory, 'orchestrator.sqlite'))
const at = new Date().toISOString()
let base = ''
let closes: () => Promise<void>

beforeAll(async () => {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice' }] }, github: { allowed: [{ id: 'alice' }] } } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(feishuKind); sources.register(githubKind)
  const assessor: Assessor = { request: async () => {} }
  const executor: Executor = { start: async () => {}, deliver: async () => {}, stop: async () => {} }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const deployment = testDeployment()
  const runtime = {
    store, sources, engine, health: board.all, machine: { promptMaxChars: { get: () => 1000 } }, masterId: 'main',
    sourceLinks: { entries: () => [] }, links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    prompts: { current: () => '', version: () => 'v', history: () => ({ items: [], total: 0, next_offset: null }), preview: () => '', save: async () => ({}), defaultChanged: () => false },
    sessions: { status: () => ({}), notify: () => {}, delivery: async () => 'none' },
    settings: { view: () => ({}), save: async () => ({}), pause: () => ({}), sync: async () => ({}), refreshLabels: async () => ({}) },
    executor: { activeCount: 0 }, configured: () => true, ticketEnvironment: () => [],
  } as never
  let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    await handler?.(req, res)
    if (!res.writableEnded) res.writeHead(404).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  // Routes are registered after listen so `sameOrigin` compares against the port the panel actually calls.
  registerHttp({ webServer: { host: '127.0.0.1', port, register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } } as never, runtime)
  base = `http://127.0.0.1:${port}/orchestrator/api`
  closes = () => new Promise<void>(resolve => { server.close(() => resolve()) })
})

afterAll(async () => {
  await closes()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/** The same Ticket shape the domain stores, opened through the real repository write. */
const seed = (id: string) => store.tickets.save({ id, title: 'Fix login', decisionId: 'd1', channels: [], undelivered: [], createdAt: at,
  updatedAt: at, assignments: [{ id: `${id}-a1`, state: 'ended', createdAt: at }], inputs: [],
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  origin: { triggerId: 'e1', triggerIds: ['e1'] } } as never)

const post = (path: string, body?: unknown) => fetch(`${base}/${path}`, { method: 'POST',
  headers: { host: new URL(base).host, 'x-orchestrator-request': '1', origin: `http://${new URL(base).host}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

it('answers a panel request that carries no reason by stopping without one', async () => {
  seed('t-no-reason')
  const response = await post('tickets/t-no-reason/stop', {})
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ stopped: true })
  expect(store.tickets.get('t-no-reason')!.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
  expect(store.tickets.get('t-no-reason')!.ended?.reason).toBeUndefined()
})

it('stops a Ticket over a real socket and reads its reason back out of the real database', async () => {
  seed('t-reason')
  const response = await post('tickets/t-reason/stop', { reason: '人已接管，agent 停手' })
  expect(response.status).toBe(200)
  expect(store.tickets.get('t-reason')!.ended?.reason).toBe('人已接管，agent 停手')
})

it('refuses a body whose reason is not text with 400, and leaves the Ticket open', async () => {
  seed('t-bad')
  const response = await post('tickets/t-bad/stop', { reason: 7 })
  expect(response.status).toBe(400)
  expect(store.tickets.get('t-bad')!.ended).toBeUndefined()
})

it('rejects a stop request with no body at all, the way the other panel routes do', async () => {
  seed('t-empty')
  const response = await fetch(`${base}/tickets/t-empty/stop`, { method: 'POST',
    headers: { host: new URL(base).host, 'x-orchestrator-request': '1', origin: `http://${new URL(base).host}` } })
  expect(response.status).toBe(400)
  expect(store.tickets.get('t-empty')!.ended).toBeUndefined()
})

it('refuses a cross-origin caller before the route reads its body', async () => {
  seed('t-cors')
  const response = await fetch(`${base}/tickets/t-cors/stop`, { method: 'POST', headers: { host: new URL(base).host, origin: 'https://evil.example' },
    body: '{}' })
  expect(response.status).toBe(403)
  expect(store.tickets.get('t-cors')!.ended).toBeUndefined()
})
