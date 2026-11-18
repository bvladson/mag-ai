// @ts-check
import http from 'node:http';
import { newKey } from '../src/auth.mjs';
import { loadSettings, parseApps } from '../src/config.mjs';
import { createGateway } from '../src/server.mjs';

export const MODEL = 'qwen3.5:0.8b-q8_0';

/** @param {http.Server} server */
export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

/** @param {http.Server} server */
export function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve(undefined));
  });
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera uma condição ficar verdadeira (até 3 s).
 * @param {() => boolean} cond
 */
export async function until(cond) {
  for (let i = 0; i < 150; i += 1) {
    if (cond()) return true;
    await sleep(20);
  }
  return false;
}

/** Porta onde ninguém escuta (para simular o Ollama fora do ar). */
export async function closedPortUrl() {
  const s = http.createServer();
  const url = await listen(s);
  await close(s);
  return url;
}

/**
 * Ollama de mentira: devolve NDJSON em pedaços, guarda os pedidos e conta quantos rodaram juntos.
 * @param {{ chunks?: string[], delayMs?: number, status?: number, hang?: boolean, errorLine?: boolean, models?: object[] }} [opts]
 */
export async function fakeOllama({ chunks = ['Olá', ', mundo'], delayMs = 0, status = 200, hang = false, errorLine = false, models = [] } = {}) {
  /** @type {{ requests: any[], active: number, maxActive: number, aborted: number }} */
  const state = { requests: [], active: 0, maxActive: 0, aborted: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/ps') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models }));
    }
    let raw = '';
    for await (const c of req) raw += c;
    state.requests.push(JSON.parse(raw));
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    let finished = false;
    res.on('close', () => {
      state.active -= 1;
      if (!finished) state.aborted += 1;
    });
    if (status !== 200) {
      finished = true;
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'falha simulada' }));
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (hang) return;
    for (const c of chunks) {
      if (delayMs) await sleep(delayMs);
      if (res.destroyed) return;
      res.write(`${JSON.stringify({ model: MODEL, message: { role: 'assistant', content: c }, done: false })}\n`);
    }
    finished = true;
    if (errorLine) return res.end(`${JSON.stringify({ error: 'erro no meio' })}\n`);
    res.end(
      `${JSON.stringify({
        model: MODEL,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 42,
        eval_count: chunks.length,
        load_duration: 5e6,
        prompt_eval_duration: 2e7,
        eval_duration: 3e7,
      })}\n`,
    );
  });
  const url = await listen(server);
  return { url, state, server };
}

/**
 * Sobe um gateway de teste. A primeira aplicação se chama "biomie".
 * @param {{ ollamaUrl: string, settings?: Record<string, unknown>, apps?: Record<string, unknown>[] }} opts
 */
export async function startGateway({ ollamaUrl, settings = {}, apps = [{}] }) {
  /** @type {Record<string, string>} */
  const keys = {};
  /** @type {string[]} */
  const logs = [];
  const appDefs = apps.map((a, i) => {
    const id = /** @type {string} */ (a.id ?? (i === 0 ? 'biomie' : `app${i}`));
    const { key, sha256 } = newKey(id);
    keys[id] = key;
    return {
      tasks: ['explicar', 'resumir', 'responder', 'classificar'],
      rpm: 100,
      daily: 1000,
      max_input_chars: 12000,
      max_output_tokens: 400,
      timeout_s: 5,
      allow_json: true,
      ...a,
      id,
      key_sha256: sha256,
    };
  });
  const s = { ...loadSettings({ MAG_AI_MODEL: MODEL, OLLAMA_URL: ollamaUrl }), ...settings };
  const gw = createGateway({
    settings: s,
    apps: parseApps({ apps: appDefs }),
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
  const url = await listen(gw.api);
  const metricsUrl = await listen(gw.internal);
  return {
    url,
    metricsUrl,
    keys,
    logs,
    gw,
    async stop() {
      await close(gw.api);
      await close(gw.internal);
    },
  };
}

/**
 * @param {string} url
 * @param {string | null} key
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @param {AbortSignal} [signal]
 */
export function chat(url, key, body, headers = {}, signal) {
  return fetch(`${url}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

/** @param {Record<string, unknown>} [over] */
export const basic = (over = {}) => ({
  task: 'explicar',
  messages: [
    { role: 'system', content: 'Você explica números de vendas em português.' },
    { role: 'user', content: 'Faturamento de outubro: R$ 100.000,00.' },
  ],
  ...over,
});
