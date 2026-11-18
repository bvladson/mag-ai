// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basic, chat, closedPortUrl, fakeOllama, MODEL, sleep, startGateway, until } from './helpers.mjs';

/**
 * @param {import('node:test').TestContext} t
 * @param {Parameters<typeof fakeOllama>[0]} [fakeOpts]
 * @param {Omit<Parameters<typeof startGateway>[0], 'ollamaUrl'>} [gwOpts]
 */
async function setup(t, fakeOpts = {}, gwOpts = {}) {
  const fake = await fakeOllama(fakeOpts);
  const gw = await startGateway({ ollamaUrl: fake.url, ...gwOpts });
  t.after(async () => {
    await gw.stop();
    fake.server.closeAllConnections();
    fake.server.close();
  });
  return { fake, gw };
}

test('saúde, rotas desconhecidas e métodos', async (t) => {
  const { gw } = await setup(t, { models: [{ name: MODEL, model: MODEL }] });
  const live = await fetch(`${gw.url}/v1/health/live`);
  assert.equal(live.status, 200);
  const health = await (await fetch(`${gw.url}/v1/health`)).json();
  assert.deepEqual(health, { status: 'ok', ollama: 'up', model_loaded: true, queue: 0, analise: 'off' });
  for (const [method, path] of [['GET', '/api/tags'], ['POST', '/api/pull'], ['POST', '/api/generate'], ['DELETE', '/api/delete']]) {
    const r = await fetch(`${gw.url}${path}`, { method, headers: { authorization: `Bearer ${gw.keys.biomie}` } });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal((await fetch(`${gw.url}/v1/chat`)).status, 405);
});

test('sem chave, chave errada ou adulterada: 401 e nada chega ao Ollama', async (t) => {
  const { fake, gw } = await setup(t);
  assert.equal((await chat(gw.url, null, basic())).status, 401);
  assert.equal((await chat(gw.url, 'qualquer-coisa', basic())).status, 401);
  const forged = `${gw.keys.biomie.slice(0, -1)}${gw.keys.biomie.endsWith('A') ? 'B' : 'A'}`;
  const r = await chat(gw.url, forged, basic());
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'unauthorized');
  assert.equal(fake.state.requests.length, 0);
  assert.ok(!gw.logs.join('\n').includes(gw.keys.biomie.slice(-20)));
});

test('o gateway fixa modelo, contexto, threads, permanência e desliga o raciocínio', async (t) => {
  const { fake, gw } = await setup(t);
  const r = await chat(
    gw.url,
    gw.keys.biomie,
    basic({
      model: 'outro-modelo',
      options: { num_ctx: 262144, num_thread: 2 },
      think: true,
      keep_alive: -1,
      raw: true,
      template: '{{ .Prompt }}',
      max_tokens: 9999,
    }),
  );
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.content, 'Olá, mundo');
  assert.deepEqual(body.usage, { prompt_tokens: 42, output_tokens: 2 });
  assert.equal(body.timings.prompt_ms, 20);
  const sent = fake.state.requests[0];
  assert.deepEqual(Object.keys(sent).sort(), ['keep_alive', 'messages', 'model', 'options', 'stream', 'think']);
  assert.equal(sent.model, MODEL);
  assert.equal(sent.think, false);
  assert.equal(sent.keep_alive, '2m');
  assert.equal(sent.options.num_ctx, 2048);
  assert.equal(sent.options.num_thread, 1);
  assert.equal(sent.options.num_predict, 400, 'limitado ao teto da aplicação');
  assert.equal(sent.options.temperature, 0.3);
});

test('tarefas: desconhecida, herdada do protótipo e não liberada', async (t) => {
  const { fake, gw } = await setup(t, {}, { apps: [{ tasks: ['resumir'] }] });
  assert.equal((await (await chat(gw.url, gw.keys.biomie, basic({ task: 'inventada' }))).json()).error.code, 'invalid_task');
  assert.equal((await (await chat(gw.url, gw.keys.biomie, basic({ task: 'constructor' }))).json()).error.code, 'invalid_task');
  const r = await chat(gw.url, gw.keys.biomie, basic({ task: 'explicar' }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'task_not_allowed');
  assert.equal(fake.state.requests.length, 0);
});

test('entradas recusadas: imagem, JSON inválido, tipo errado, tamanho e contexto', async (t) => {
  const { fake, gw } = await setup(t, {}, { settings: { maxBodyBytes: 4096, numCtx: 1024 }, apps: [{ max_input_chars: 3000 }] });
  const withImage = basic({ messages: [{ role: 'user', content: 'veja', images: ['AAAA'] }] });
  assert.equal((await (await chat(gw.url, gw.keys.biomie, withImage)).json()).error.code, 'images_not_allowed');
  assert.equal((await (await chat(gw.url, gw.keys.biomie, '{ruim')).json()).error.code, 'invalid_json');
  const wrongType = await chat(gw.url, gw.keys.biomie, basic(), { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  const big = await chat(gw.url, gw.keys.biomie, basic({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] }));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.code, 'payload_too_large');
  const overApp = await chat(gw.url, gw.keys.biomie, basic({ messages: [{ role: 'user', content: 'x'.repeat(3500) }] }));
  assert.equal((await overApp.json()).error.code, 'input_too_large');
  const overCtx = await chat(gw.url, gw.keys.biomie, basic({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] }));
  assert.equal(overCtx.status, 413);
  assert.equal((await overCtx.json()).error.code, 'context_too_large');
  const noUser = await chat(gw.url, gw.keys.biomie, basic({ messages: [{ role: 'system', content: 'só sistema' }] }));
  assert.equal((await noUser.json()).error.code, 'invalid_messages');
  assert.equal(fake.state.requests.length, 0);
});

test('classificar exige esquema JSON; aplicação sem JSON liberado recebe 403', async (t) => {
  const { fake, gw } = await setup(t, { chunks: ['{"intencao":"faturamento"}'] }, { apps: [{}, { id: 'semjson', allow_json: false }] });
  const schema = { type: 'object', properties: { intencao: { type: 'string', enum: ['faturamento', 'outro'] } }, required: ['intencao'] };
  assert.equal((await (await chat(gw.url, gw.keys.biomie, basic({ task: 'classificar' }))).json()).error.code, 'format_required');
  const ok = await chat(gw.url, gw.keys.biomie, basic({ task: 'classificar', format: schema }));
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse((await ok.json()).content), { intencao: 'faturamento' });
  assert.deepEqual(fake.state.requests[0].format, schema);
  assert.equal(fake.state.requests[0].options.temperature, 0);
  const denied = await chat(gw.url, gw.keys.semjson, basic({ format: 'json' }));
  assert.equal(denied.status, 403);
});

test('streaming NDJSON: pedaços e linha final com uso e tempos', async (t) => {
  const { gw } = await setup(t);
  const r = await chat(gw.url, gw.keys.biomie, basic({ stream: true }));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.slice(0, 2), [{ type: 'delta', content: 'Olá' }, { type: 'delta', content: ', mundo' }]);
  assert.equal(lines[2].type, 'done');
  assert.deepEqual(lines[2].usage, { prompt_tokens: 42, output_tokens: 2 });
});

test('limite por minuto e cota diária devolvem 429 com Retry-After', async (t) => {
  const { gw } = await setup(t, {}, { apps: [{ rpm: 2 }, { id: 'cota', daily: 1 }] });
  assert.equal((await chat(gw.url, gw.keys.biomie, basic())).status, 200);
  assert.equal((await chat(gw.url, gw.keys.biomie, basic())).status, 200);
  const third = await chat(gw.url, gw.keys.biomie, basic());
  assert.equal(third.status, 429);
  assert.equal((await third.json()).error.code, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  assert.equal((await chat(gw.url, gw.keys.cota, basic())).status, 200);
  const over = await chat(gw.url, gw.keys.cota, basic());
  assert.equal((await over.json()).error.code, 'daily_quota');
});

test('fila única: uma geração por vez; excedente recebe 503 busy', async (t) => {
  const { fake, gw } = await setup(t, { chunks: ['a', 'b', 'c'], delayMs: 80 }, { settings: { queueMax: 1 } });
  const results = await Promise.all([1, 2, 3].map(() => chat(gw.url, gw.keys.biomie, basic())));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 503]);
  const busy = /** @type {Response} */ (results.find((r) => r.status === 503));
  assert.equal((await busy.json()).error.code, 'busy');
  assert.ok(Number(busy.headers.get('retry-after')) >= 1);
  assert.equal(fake.state.maxActive, 1, 'o Ollama nunca recebeu dois pedidos ao mesmo tempo');
});

test('prazo esgotado: 504 e a geração é cancelada no Ollama', async (t) => {
  const { fake, gw } = await setup(t, { hang: true }, { apps: [{ timeout_s: 0.3 }] });
  const r = await chat(gw.url, gw.keys.biomie, basic());
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.code, 'timeout');
  assert.ok(await until(() => fake.state.aborted === 1), 'o Ollama viu o cancelamento');
});

test('cliente desiste no meio: a geração é cancelada e o registro fica como 499', async (t) => {
  const { fake, gw } = await setup(t, { chunks: ['um', 'dois', 'tres', 'quatro', 'cinco'], delayMs: 150 });
  const controller = new AbortController();
  const r = await chat(gw.url, gw.keys.biomie, basic({ stream: true }), {}, controller.signal);
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (r.body?.getReader());
  await reader.read();
  controller.abort();
  assert.ok(await until(() => fake.state.aborted === 1), 'o Ollama viu o cancelamento');
  assert.ok(await until(() => gw.logs.some((l) => JSON.parse(l).status === 499)), 'registro 499');
  assert.equal(gw.gw.gate.active, 0, 'a vaga foi liberada');
});

test('Ollama fora do ar: 503 e o disjuntor passa a recusar na hora', async (t) => {
  const down = await closedPortUrl();
  const gw = await startGateway({ ollamaUrl: down, settings: { breakerFailures: 2, breakerOpenMs: 60_000 } });
  t.after(() => gw.stop());
  for (let i = 0; i < 2; i += 1) {
    const r = await chat(gw.url, gw.keys.biomie, basic());
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'upstream_unavailable');
  }
  const started = Date.now();
  const blocked = await chat(gw.url, gw.keys.biomie, basic());
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.ok(Date.now() - started < 500);
  assert.equal(gw.gw.breaker.state, 'open');
  const health = await (await fetch(`${gw.url}/v1/health`)).json();
  assert.equal(health.status, 'degraded');
  assert.equal(health.ollama, 'down');
});

test('Ollama com erro no meio ou fila cheia do lado dele', async (t) => {
  const { gw } = await setup(t, { errorLine: true });
  const r = await chat(gw.url, gw.keys.biomie, basic());
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, 'upstream_error');
  const full = await setup(t, { status: 503 });
  const busy = await chat(full.gw.url, full.gw.keys.biomie, basic());
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).error.code, 'busy');
});

test('logs e métricas sem texto do pedido, da resposta ou da chave', async (t) => {
  const { gw } = await setup(t, { chunks: ['RESPOSTA-SIGILOSA'] });
  const secret = 'SEGREDO-DO-CLIENTE-123';
  const r = await chat(gw.url, gw.keys.biomie, basic({ messages: [{ role: 'user', content: `Cliente ${secret} comprou R$ 5.000,00` }] }));
  assert.equal(r.status, 200);
  await sleep(20);
  const metrics = await (await fetch(`${gw.metricsUrl}/metrics`)).text();
  const all = `${gw.logs.join('\n')}\n${metrics}`;
  for (const forbidden of [secret, 'RESPOSTA-SIGILOSA', gw.keys.biomie]) assert.ok(!all.includes(forbidden), forbidden);
  const entry = JSON.parse(/** @type {string} */ (gw.logs.find((l) => JSON.parse(l).event === 'pedido')));
  assert.equal(entry.app, 'biomie');
  assert.equal(entry.status, 200);
  assert.equal(entry.prompt_tokens, 42);
  const m = JSON.parse(metrics);
  assert.equal(m.apps.biomie.requests, 1);
  assert.equal(m.used_today.biomie, 1);
  assert.equal(m.last_5min.ok, 1);
});
