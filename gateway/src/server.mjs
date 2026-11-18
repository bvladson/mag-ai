// @ts-check
/**
 * MAG AI — gateway interno na frente do Ollama.
 *
 * Porta 8080 (só nas redes internas dos clientes, sem porta no servidor):
 *   POST /v1/chat          gera texto (chave da aplicação obrigatória)
 *   GET  /v1/health        situação resumida (Ollama no ar? modelo carregado? fila)
 *   GET  /v1/health/live   o processo do gateway está vivo (usado pelo healthcheck do Docker)
 * Porta 9090 só em 127.0.0.1 dentro do container:
 *   GET  /metrics          contadores para o monitor (lido com docker exec)
 *
 * Regras: uma geração por vez; fila curta; prazo por aplicação; cliente que desiste cancela a geração;
 * nunca registra o texto dos pedidos nem das respostas.
 */
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authenticate } from './auth.mjs';
import { Breaker } from './breaker.mjs';
import { loadApps, loadSettings } from './config.mjs';
import { MESSAGES, RequestError } from './errors.mjs';
import { Gate, GateError } from './gate.mjs';
import { RateLimiter } from './limits.mjs';
import { makeLogger } from './log.mjs';
import { Metrics } from './metrics.mjs';
import { buildChatBody, readChatStream, UpstreamError } from './ollama.mjs';
import { validateChat } from './validate.mjs';

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {import('./errors.mjs').ErrorCode} code
 * @param {number} [retryAfterS]
 */
function sendError(res, status, code, retryAfterS = 0) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (retryAfterS > 0) headers['retry-after'] = String(retryAfterS);
  if (status === 413) headers.connection = 'close';
  sendJson(res, status, { error: { code, message: MESSAGES[code] } }, headers);
}

/** @param {unknown} value */
function requestId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : randomUUID();
}

/**
 * @param {http.IncomingMessage} req
 * @param {number} limit
 */
async function readJson(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new RequestError(413, 'payload_too_large');
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid_json');
  }
}

/**
 * @param {{
 *   settings: import('./config.mjs').Settings,
 *   apps: import('./config.mjs').AppPolicy[],
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   log?: (event: string, fields?: Record<string, unknown>) => void,
 * }} deps
 */
export function createGateway({ settings, apps, fetchImpl = globalThis.fetch, now = Date.now, log = makeLogger() }) {
  const limiter = new RateLimiter(now);
  const gate = new Gate({ slots: 1, maxQueue: settings.queueMax, maxWaitMs: settings.queueWaitMs });
  const breaker = new Breaker({ failures: settings.breakerFailures, openMs: settings.breakerOpenMs, now });
  const metrics = new Metrics(apps.map((a) => a.id), now);
  /** @type {{ at: number, value: Record<string, unknown> | null }} */
  let healthCache = { at: -Infinity, value: null };
  const queueRetryS = Math.max(1, Math.ceil(settings.queueWaitMs / 1000));

  async function health() {
    if (healthCache.value && now() - healthCache.at < 5000) return healthCache.value;
    let ollama = 'down';
    let modelLoaded = false;
    try {
      const r = await fetchImpl(`${settings.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        /** @type {any} */
        const j = await r.json();
        ollama = 'up';
        modelLoaded =
          Array.isArray(j?.models) &&
          j.models.some((/** @type {any} */ m) => m?.name === settings.model || m?.model === settings.model);
      } else {
        await r.body?.cancel();
      }
    } catch {
      // Ollama fora do ar ou lento: fica "down".
    }
    const value = {
      status: ollama === 'up' && breaker.state !== 'open' ? 'ok' : 'degraded',
      ollama,
      model_loaded: modelLoaded,
      queue: gate.queued,
      // Segundo modelo (tarefa "analisar"): o cliente usa isto para mostrar ou esconder o botão.
      analise: settings.modelAnalise ? 'on' : 'off',
    };
    healthCache = { at: now(), value };
    return value;
  }

  /**
   * @param {import('./config.mjs').AppPolicy} app
   * @param {import('./validate.mjs').ChatInput} input
   * @param {http.ServerResponse} res
   * @param {AbortController} abort
   * @param {Record<string, any>} info
   * @param {() => boolean} clientGone
   */
  async function generate(app, input, res, abort, info, clientGone) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, app.timeoutMs);
    try {
      /** @type {Response} */
      let response;
      try {
        response = await fetchImpl(`${settings.ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildChatBody(settings, app, input)),
          signal: abort.signal,
        });
      } catch {
        if (timedOut) throw new RequestError(504, 'timeout');
        if (clientGone()) return;
        breaker.failure();
        throw new RequestError(503, 'upstream_unavailable', 5);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 503) throw new RequestError(503, 'busy', queueRetryS);
        if (response.status >= 500) breaker.failure();
        throw new RequestError(502, 'upstream_error');
      }
      if (input.stream) {
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        });
      }
      let text = '';
      /** @type {Awaited<ReturnType<typeof readChatStream>>} */
      let result;
      try {
        result = await readChatStream(/** @type {any} */ (response.body), (delta) => {
          if (input.stream) res.write(`${JSON.stringify({ type: 'delta', content: delta })}\n`);
          else text += delta;
        });
      } catch (err) {
        if (timedOut) throw new RequestError(504, 'timeout');
        if (clientGone()) return;
        breaker.failure();
        if (err instanceof UpstreamError) info.upstream = err.code;
        throw new RequestError(502, 'upstream_error');
      }
      breaker.success();
      info.prompt_tokens = result.promptTokens;
      info.output_tokens = result.outputTokens;
      info.done_reason = result.doneReason;
      if (result.promptTokens + result.outputTokens >= settings.numCtx - 8) {
        log('aviso_contexto', { rid: info.rid, app: app.id, prompt_tokens: result.promptTokens, output_tokens: result.outputTokens });
      }
      const payload = {
        id: info.rid,
        model: settings.model,
        done_reason: result.doneReason,
        usage: { prompt_tokens: result.promptTokens, output_tokens: result.outputTokens },
        timings: {
          queue_ms: info.queue_ms,
          load_ms: result.loadMs,
          prompt_ms: result.promptMs,
          generate_ms: result.generateMs,
        },
      };
      if (input.stream) res.end(`${JSON.stringify({ type: 'done', ...payload })}\n`);
      else sendJson(res, 200, { ...payload, content: text });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} rid
   */
  async function chat(req, res, rid) {
    const started = now();
    const app = authenticate(apps, req.headers.authorization);
    if (!app) {
      req.resume();
      log('pedido', { rid, app: null, status: 401, code: 'unauthorized', total_ms: now() - started });
      return sendError(res, 401, 'unauthorized');
    }
    /** @type {Record<string, any>} */
    const info = {
      rid,
      app: app.id,
      task: null,
      status: 0,
      code: null,
      queue_ms: 0,
      est_input_tokens: 0,
      prompt_tokens: 0,
      output_tokens: 0,
      done_reason: null,
      total_ms: 0,
    };
    /**
     * @param {number} status
     * @param {string | null} [code]
     */
    const done = (status, code = null) => {
      info.status = status;
      info.code = code;
      info.total_ms = now() - started;
      metrics.record(app.id, {
        status,
        code,
        totalMs: info.total_ms,
        promptTokens: info.prompt_tokens,
        outputTokens: info.output_tokens,
      });
      log('pedido', info);
    };

    const abort = new AbortController();
    let gone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        gone = true;
        abort.abort();
      }
    });
    const clientGone = () => gone;

    try {
      const type = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('application/json')) {
        req.resume();
        throw new RequestError(415, 'unsupported_media_type');
      }
      const input = validateChat(await readJson(req, settings.maxBodyBytes), app, settings);
      info.task = input.task;
      info.est_input_tokens = input.estInputTokens;

      const quota = limiter.take(app);
      if (!quota.ok) throw new RequestError(429, quota.reason === 'daily' ? 'daily_quota' : 'rate_limited', quota.retryAfterS);
      const blocked = breaker.retryAfterS();
      if (blocked > 0) throw new RequestError(503, 'upstream_unavailable', blocked);

      const waitStart = now();
      /** @type {() => void} */
      let release;
      try {
        release = await gate.acquire(app.priority, abort.signal);
      } catch (err) {
        if (err instanceof GateError && err.code === 'aborted') return done(499, 'client_closed');
        throw new RequestError(503, 'busy', queueRetryS);
      }
      info.queue_ms = now() - waitStart;
      try {
        await generate(app, input, res, abort, info, clientGone);
      } finally {
        release();
      }
      return gone ? done(499, 'client_closed') : done(200);
    } catch (err) {
      if (gone) return done(499, 'client_closed');
      if (!(err instanceof RequestError)) {
        log('erro_interno', { rid, app: app.id, name: err instanceof Error ? err.name : typeof err });
        if (!res.headersSent) sendError(res, 500, 'internal_error');
        else res.end(`${JSON.stringify({ type: 'error', error: { code: 'internal_error', message: MESSAGES.internal_error } })}\n`);
        return done(500, 'internal_error');
      }
      if (!res.headersSent) sendError(res, err.status, err.code, err.retryAfterS);
      else res.end(`${JSON.stringify({ type: 'error', error: { code: err.code, message: err.message } })}\n`);
      return done(err.status, err.code);
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function route(req, res) {
    const rid = requestId(req.headers['x-request-id']);
    res.setHeader('x-request-id', rid);
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/v1/chat') {
      if (req.method !== 'POST') {
        req.resume();
        return sendError(res, 405, 'method_not_allowed');
      }
      return chat(req, res, rid);
    }
    req.resume();
    if (req.method === 'GET' && pathname === '/v1/health/live') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && pathname === '/v1/health') return sendJson(res, 200, await health());
    return sendError(res, 404, 'not_found');
  }

  const api = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('erro_interno', { name: err instanceof Error ? err.name : typeof err });
      if (!res.headersSent) sendError(res, 500, 'internal_error');
      else res.destroy();
    });
  });
  api.headersTimeout = 10_000;
  api.requestTimeout = 30_000; // prazo para RECEBER o pedido; a geração tem o prazo da aplicação
  api.keepAliveTimeout = 5_000;
  api.maxConnections = 64;

  const internal = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/metrics') {
      return sendJson(
        res,
        200,
        metrics.snapshot({
          model: settings.model,
          gate: { active: gate.active, queued: gate.queued, max_queue: settings.queueMax },
          breaker: breaker.state,
          used_today: Object.fromEntries(apps.map((a) => [a.id, limiter.usedToday(a.id)])),
        }),
      );
    }
    return sendError(res, 404, 'not_found');
  });

  return { api, internal, gate, breaker, metrics, limiter };
}

function main() {
  const log = makeLogger();
  const settings = loadSettings(process.env);
  const apps = loadApps(process.env.MAG_AI_APPS_FILE ?? '/run/mag-ai/apps.json');
  const gw = createGateway({ settings, apps, log });
  gw.api.listen(settings.port, '0.0.0.0');
  gw.internal.listen(settings.metricsPort, '127.0.0.1');
  log('inicio', {
    model: settings.model,
    num_ctx: settings.numCtx,
    num_thread: settings.numThread,
    keep_alive: settings.keepAlive,
    queue_max: settings.queueMax,
    apps: apps.map((a) => a.id),
  });
  /** @param {string} signal */
  const stop = (signal) => {
    log('parada', { signal });
    gw.internal.close();
    gw.api.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
