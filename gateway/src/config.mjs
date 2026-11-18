// @ts-check
/**
 * Configuração do gateway MAG AI.
 * - Ajustes gerais vêm de variáveis de ambiente (nenhum segredo nelas).
 * - Aplicações vêm de um arquivo JSON montado só leitura, com o SHA-256 de cada chave (nunca a chave).
 */
import { readFileSync } from 'node:fs';

/**
 * Tarefas aceitas. O cliente escolhe a tarefa; temperatura e teto de resposta ficam aqui.
 * "analisar" usa o SEGUNDO modelo (MAG_AI_MODEL_ANALISE, ex.: DeepSeek-R1) com o modo de
 * raciocínio ligado e contexto maior; o raciocínio nunca é repassado ao cliente.
 * Sem MAG_AI_MODEL_ANALISE no ambiente, a tarefa é recusada (task_not_allowed).
 */
export const TASKS = Object.freeze({
  explicar: Object.freeze({ temperature: 0.3, maxTokens: 350, requiresFormat: false }),
  resumir: Object.freeze({ temperature: 0.3, maxTokens: 300, requiresFormat: false }),
  responder: Object.freeze({ temperature: 0.2, maxTokens: 300, requiresFormat: false }),
  classificar: Object.freeze({ temperature: 0, maxTokens: 160, requiresFormat: true }),
  analisar: Object.freeze({
    temperature: 0.5,
    maxTokens: 900,
    requiresFormat: false,
    model: 'analise',
    numCtx: 4096,
    think: true,
  }),
});

/** Tetos absolutos por aplicação: o arquivo não passa disso. */
export const HARD_LIMITS = Object.freeze({
  rpm: 120,
  daily: 20000,
  maxInputChars: 24000,
  maxOutputTokens: 1024,
  timeoutS: 300,
});

export const APP_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function num(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} fora do intervalo ${min}–${max}: ${String(value)}`);
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function int(value, fallback, min, max, name) {
  const n = num(value, fallback, min, max, name);
  if (!Number.isInteger(n)) throw new Error(`${name} deve ser inteiro: ${String(value)}`);
  return n;
}

/**
 * @typedef {object} Settings
 * @property {number} port
 * @property {number} metricsPort
 * @property {string} ollamaUrl
 * @property {string} model
 * @property {string} modelAnalise vazio = tarefa "analisar" desligada
 * @property {number} numCtx
 * @property {number} numThread
 * @property {string} keepAlive
 * @property {number} queueMax
 * @property {number} queueWaitMs
 * @property {number} maxBodyBytes
 * @property {number} topP
 * @property {number} topK
 * @property {number} presencePenalty
 * @property {number} breakerFailures
 * @property {number} breakerOpenMs
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Settings}
 */
export function loadSettings(env) {
  const model = env.MAG_AI_MODEL;
  if (!model || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model)) {
    throw new Error('MAG_AI_MODEL ausente ou inválido');
  }
  const modelAnalise = env.MAG_AI_MODEL_ANALISE ?? '';
  if (modelAnalise && !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(modelAnalise)) {
    throw new Error('MAG_AI_MODEL_ANALISE inválido');
  }
  const keepAlive = env.MAG_AI_KEEP_ALIVE ?? '2m';
  if (!/^(-1|0|\d{1,6}(ms|s|m|h))$/.test(keepAlive)) throw new Error(`MAG_AI_KEEP_ALIVE inválido: ${keepAlive}`);
  return {
    port: int(env.PORT, 8080, 1, 65535, 'PORT'),
    metricsPort: int(env.MAG_AI_METRICS_PORT, 9090, 1, 65535, 'MAG_AI_METRICS_PORT'),
    ollamaUrl: (env.OLLAMA_URL ?? 'http://mag-ai-ollama:11434').replace(/\/+$/, ''),
    model,
    modelAnalise,
    numCtx: int(env.MAG_AI_NUM_CTX, 2048, 512, 32768, 'MAG_AI_NUM_CTX'),
    numThread: int(env.MAG_AI_NUM_THREAD, 1, 1, 8, 'MAG_AI_NUM_THREAD'),
    keepAlive,
    queueMax: int(env.MAG_AI_QUEUE_MAX, 2, 0, 64, 'MAG_AI_QUEUE_MAX'),
    queueWaitMs: Math.round(num(env.MAG_AI_QUEUE_WAIT_S, 30, 0.01, 600, 'MAG_AI_QUEUE_WAIT_S') * 1000),
    maxBodyBytes: int(env.MAG_AI_MAX_BODY_BYTES, 65536, 1024, 1048576, 'MAG_AI_MAX_BODY_BYTES'),
    topP: num(env.MAG_AI_TOP_P, 0.8, 0, 1, 'MAG_AI_TOP_P'),
    topK: int(env.MAG_AI_TOP_K, 20, 1, 200, 'MAG_AI_TOP_K'),
    presencePenalty: num(env.MAG_AI_PRESENCE_PENALTY, 0.5, 0, 2, 'MAG_AI_PRESENCE_PENALTY'),
    breakerFailures: int(env.MAG_AI_BREAKER_FAILURES, 3, 1, 100, 'MAG_AI_BREAKER_FAILURES'),
    breakerOpenMs: Math.round(num(env.MAG_AI_BREAKER_OPEN_S, 30, 0.01, 3600, 'MAG_AI_BREAKER_OPEN_S') * 1000),
  };
}

/**
 * @typedef {object} AppPolicy
 * @property {string} id
 * @property {Buffer} keyHash SHA-256 da chave (32 bytes)
 * @property {readonly string[]} tasks
 * @property {number} rpm pedidos por minuto
 * @property {number} daily pedidos por dia (dia de Brasília)
 * @property {number} maxInputChars
 * @property {number} maxOutputTokens
 * @property {number} timeoutMs prazo total de cada geração
 * @property {'interactive' | 'batch'} priority
 * @property {boolean} allowJson aceita resposta em JSON com esquema
 */

/**
 * @param {any} raw conteúdo do apps.json
 * @returns {AppPolicy[]}
 */
export function parseApps(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error('apps.json: lista "apps" ausente ou vazia');
  }
  const ids = new Set();
  const keys = new Set();
  return raw.apps.map((/** @type {any} */ a, /** @type {number} */ i) => {
    const at = `apps[${i}]`;
    if (!a || typeof a !== 'object') throw new Error(`${at}: item inválido`);
    if (typeof a.id !== 'string' || !APP_ID.test(a.id)) throw new Error(`${at}.id inválido`);
    if (ids.has(a.id)) throw new Error(`${at}.id repetido: ${a.id}`);
    ids.add(a.id);
    if (typeof a.key_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.key_sha256)) {
      throw new Error(`${at}.key_sha256 deve ter 64 caracteres hexadecimais`);
    }
    if (keys.has(a.key_sha256)) throw new Error(`${at}: chave repetida`);
    keys.add(a.key_sha256);
    if (
      !Array.isArray(a.tasks) ||
      a.tasks.length === 0 ||
      a.tasks.some((/** @type {unknown} */ t) => typeof t !== 'string' || !Object.hasOwn(TASKS, t))
    ) {
      throw new Error(`${at}.tasks inválido (aceitas: ${Object.keys(TASKS).join(', ')})`);
    }
    if (a.priority !== undefined && a.priority !== 'interactive' && a.priority !== 'batch') {
      throw new Error(`${at}.priority deve ser "interactive" ou "batch"`);
    }
    /** @type {AppPolicy} */
    const policy = {
      id: a.id,
      keyHash: Buffer.from(a.key_sha256, 'hex'),
      tasks: Object.freeze([...new Set(/** @type {string[]} */ (a.tasks))]),
      rpm: int(a.rpm, 6, 1, HARD_LIMITS.rpm, `${at}.rpm`),
      daily: int(a.daily, 300, 1, HARD_LIMITS.daily, `${at}.daily`),
      maxInputChars: int(a.max_input_chars, 12000, 100, HARD_LIMITS.maxInputChars, `${at}.max_input_chars`),
      maxOutputTokens: int(a.max_output_tokens, 400, 16, HARD_LIMITS.maxOutputTokens, `${at}.max_output_tokens`),
      timeoutMs: Math.round(num(a.timeout_s, 60, 0.05, HARD_LIMITS.timeoutS, `${at}.timeout_s`) * 1000),
      priority: a.priority === 'batch' ? 'batch' : 'interactive',
      allowJson: a.allow_json === true,
    };
    return Object.freeze(policy);
  });
}

/** @param {string} file */
export function loadApps(file) {
  return parseApps(JSON.parse(readFileSync(file, 'utf8')));
}
