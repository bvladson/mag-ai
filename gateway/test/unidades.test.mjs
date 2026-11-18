// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticate, newKey } from '../src/auth.mjs';
import { Breaker } from '../src/breaker.mjs';
import { parseApps } from '../src/config.mjs';
import { Gate, GateError } from '../src/gate.mjs';
import { brazilDay, RateLimiter, secondsToBrazilMidnight } from '../src/limits.mjs';

const hash = (/** @type {string} */ c) => c.repeat(64);

test('dia de Brasília vira às 03:00 UTC', () => {
  const before = Date.UTC(2026, 10, 5, 2, 59, 59);
  const after = Date.UTC(2026, 10, 5, 3, 0, 0);
  assert.equal(brazilDay(after) - brazilDay(before), 1);
  assert.equal(secondsToBrazilMidnight(before), 1);
});

test('balde por minuto repõe fichas com o tempo; cota diária zera à meia-noite de Brasília', () => {
  let now = Date.UTC(2026, 10, 5, 15, 0, 0);
  const limiter = new RateLimiter(() => now);
  const app = { id: 'a', rpm: 2, daily: 3 };
  assert.equal(limiter.take(app).ok, true);
  assert.equal(limiter.take(app).ok, true);
  const third = limiter.take(app);
  assert.deepEqual(third, { ok: false, reason: 'rpm', retryAfterS: 30 });
  now += 30_000;
  assert.equal(limiter.take(app).ok, true);
  now += 60_000;
  const daily = limiter.take(app);
  assert.equal(daily.reason, 'daily');
  assert.equal(limiter.usedToday('a'), 3);
  now = Date.UTC(2026, 10, 6, 3, 0, 1);
  assert.equal(limiter.take(app).ok, true);
  assert.equal(limiter.usedToday('a'), 1);
});

test('fila: interativo passa à frente do lote; prazo e desistência tiram da fila', async () => {
  const gate = new Gate({ slots: 1, maxQueue: 3, maxWaitMs: 1000 });
  const first = await gate.acquire('interactive');
  /** @type {string[]} */
  const order = [];
  const batch = gate.acquire('batch').then((rel) => { order.push('lote'); rel(); });
  const inter = gate.acquire('interactive').then((rel) => { order.push('interativo'); rel(); });
  assert.equal(gate.queued, 2);
  first();
  first(); // liberar duas vezes não abre vaga extra
  await Promise.all([batch, inter]);
  assert.deepEqual(order, ['interativo', 'lote']);
  assert.equal(gate.active, 0);

  const short = new Gate({ slots: 1, maxQueue: 1, maxWaitMs: 30 });
  const hold = await short.acquire();
  await assert.rejects(short.acquire(), (e) => e instanceof GateError && e.code === 'queue_timeout');
  const controller = new AbortController();
  const waiting = short.acquire('interactive', controller.signal);
  await assert.rejects(short.acquire(), (e) => e instanceof GateError && e.code === 'queue_full');
  controller.abort();
  await assert.rejects(waiting, (e) => e instanceof GateError && e.code === 'aborted');
  assert.equal(short.queued, 0);
  hold();
  assert.equal(short.active, 0);
});

test('disjuntor abre após N falhas, reabre na primeira falha depois da pausa e fecha com sucesso', () => {
  let now = 0;
  const b = new Breaker({ failures: 2, openMs: 1000, now: () => now });
  b.failure();
  assert.equal(b.state, 'closed');
  b.failure();
  assert.equal(b.state, 'open');
  assert.equal(b.retryAfterS(), 1);
  now = 1001;
  assert.equal(b.state, 'half_open');
  b.failure();
  assert.equal(b.state, 'open');
  now = 2002;
  b.success();
  assert.equal(b.state, 'closed');
});

test('apps.json inválido é recusado', () => {
  const ok = { id: 'biomie', key_sha256: hash('a'), tasks: ['explicar'] };
  assert.equal(parseApps({ apps: [ok] })[0].rpm, 6);
  assert.throws(() => parseApps({ apps: [] }), /vazia/);
  assert.throws(() => parseApps({ apps: [{ ...ok, key_sha256: 'curto' }] }), /64 caracteres/);
  assert.throws(() => parseApps({ apps: [ok, { ...ok, key_sha256: hash('b') }] }), /repetido/);
  assert.throws(() => parseApps({ apps: [ok, { ...ok, id: 'outro' }] }), /chave repetida/);
  assert.throws(() => parseApps({ apps: [{ ...ok, tasks: ['constructor'] }] }), /tasks/);
  assert.throws(() => parseApps({ apps: [{ ...ok, rpm: 999 }] }), /rpm/);
  assert.throws(() => parseApps({ apps: [{ ...ok, id: 'Maiuscula' }] }), /id/);
  assert.throws(() => parseApps({ apps: [{ ...ok, priority: 'urgente' }] }), /priority/);
});

test('autenticação encontra a aplicação certa e recusa variações', () => {
  const a = newKey('biomie');
  const b = newKey('crm');
  assert.match(a.key, /^magai_biomie_[A-Za-z0-9_-]{43}$/);
  const apps = parseApps({
    apps: [
      { id: 'biomie', key_sha256: a.sha256, tasks: ['explicar'] },
      { id: 'crm', key_sha256: b.sha256, tasks: ['resumir'] },
    ],
  });
  assert.equal(authenticate(apps, `Bearer ${b.key}`)?.id, 'crm');
  assert.equal(authenticate(apps, `Bearer ${a.key}`)?.id, 'biomie');
  assert.equal(authenticate(apps, a.key), null);
  assert.equal(authenticate(apps, `Bearer  ${a.key}`), null);
  assert.equal(authenticate(apps, `Bearer ${a.key}x`), null);
  assert.equal(authenticate(apps, `Bearer ${a.key.replace('biomie', 'crm')}`), null);
  assert.equal(authenticate(apps, undefined), null);
});

// ---------- Tarefa "analisar": segundo modelo com raciocínio (16/11/2026) ----------
import { loadSettings } from '../src/config.mjs';
import { buildChatBody, modelFor } from '../src/ollama.mjs';
import { validateChat } from '../src/validate.mjs';

const ENV_BASE = { MAG_AI_MODEL: 'qwen3.5:0.8b-q8_0' };
const APP_ANALISE = Object.freeze({
  id: 'b', tasks: Object.freeze(['responder', 'analisar']), maxInputChars: 4500,
  maxOutputTokens: 1000, timeoutMs: 200000, priority: 'interactive', allowJson: true,
});
const PEDIDO = { task: 'analisar', messages: [{ role: 'user', content: 'fatos e pergunta' }] };

test('analisar usa o segundo modelo, liga o raciocínio e amplia o contexto', () => {
  const settings = loadSettings({ ...ENV_BASE, MAG_AI_MODEL_ANALISE: 'deepseek-r1:1.5b' });
  assert.equal(modelFor(settings, 'analisar'), 'deepseek-r1:1.5b');
  assert.equal(modelFor(settings, 'responder'), 'qwen3.5:0.8b-q8_0');
  const input = validateChat(PEDIDO, APP_ANALISE, settings);
  const body = buildChatBody(settings, APP_ANALISE, input);
  assert.equal(body.model, 'deepseek-r1:1.5b');
  assert.equal(body.think, true);
  assert.equal(/** @type {any} */ (body.options).num_ctx, 4096);
  assert.equal(/** @type {any} */ (body.options).num_predict, 900);
  // As tarefas antigas seguem exatamente como eram.
  const rapido = buildChatBody(settings, APP_ANALISE, validateChat({ ...PEDIDO, task: 'responder' }, APP_ANALISE, settings));
  assert.equal(rapido.model, 'qwen3.5:0.8b-q8_0');
  assert.equal(rapido.think, false);
  assert.equal(/** @type {any} */ (rapido.options).num_ctx, 2048);
});

test('sem MAG_AI_MODEL_ANALISE a tarefa analisar é recusada (e inválida continua inválida)', () => {
  const settings = loadSettings(ENV_BASE);
  assert.equal(settings.modelAnalise, '');
  assert.throws(() => validateChat(PEDIDO, APP_ANALISE, settings), { code: 'task_not_allowed' });
  assert.throws(() => loadSettings({ ...ENV_BASE, MAG_AI_MODEL_ANALISE: 'inv álido' }), /MAG_AI_MODEL_ANALISE/);
});

test('o contexto maior da análise aceita fatos que estourariam o contexto padrão', () => {
  const settings = loadSettings({ ...ENV_BASE, MAG_AI_MODEL_ANALISE: 'deepseek-r1:1.5b' });
  const grande = { task: 'analisar', messages: [{ role: 'user', content: 'x'.repeat(4400) }] };
  assert.equal(validateChat(grande, APP_ANALISE, settings).task, 'analisar');
  assert.throws(
    () => validateChat({ ...grande, task: 'responder', max_tokens: 900 }, APP_ANALISE, settings),
    { code: 'context_too_large' },
  );
});
