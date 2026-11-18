// @ts-check
/** Validação do corpo de POST /v1/chat. Campos desconhecidos são ignorados (nunca repassados ao Ollama). */
import { TASKS } from './config.mjs';
import { RequestError } from './errors.mjs';

const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGES = 12;
const MAX_FORMAT_CHARS = 8192;

/**
 * @typedef {object} ChatInput
 * @property {keyof typeof TASKS} task
 * @property {{ role: 'system' | 'user' | 'assistant', content: string }[]} messages
 * @property {number | undefined} maxTokens já limitado ao teto da aplicação
 * @property {'json' | Record<string, unknown> | undefined} format
 * @property {boolean} stream
 * @property {number} estInputTokens estimativa conservadora
 */

/**
 * @param {any} raw
 * @param {import('./config.mjs').AppPolicy} app
 * @param {{ numCtx: number }} settings
 * @returns {ChatInput}
 */
export function validateChat(raw, app, settings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestError(400, 'invalid_request');

  const task = raw.task;
  if (typeof task !== 'string' || !Object.hasOwn(TASKS, task)) throw new RequestError(400, 'invalid_task');
  if (!app.tasks.includes(task)) throw new RequestError(403, 'task_not_allowed');
  const preset = TASKS[/** @type {keyof typeof TASKS} */ (task)];
  // Tarefa que exige o segundo modelo só existe quando ele está configurado no ambiente.
  if (preset.model === 'analise' && !settings.modelAnalise) throw new RequestError(403, 'task_not_allowed');

  const list = raw.messages;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) {
    throw new RequestError(400, 'invalid_messages');
  }
  let chars = 0;
  const messages = list.map((/** @type {any} */ m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new RequestError(400, 'invalid_messages');
    if ('images' in m) throw new RequestError(400, 'images_not_allowed');
    if (!ROLES.has(m.role) || typeof m.content !== 'string' || m.content.length === 0) {
      throw new RequestError(400, 'invalid_messages');
    }
    chars += m.content.length;
    return { role: /** @type {'system' | 'user' | 'assistant'} */ (m.role), content: m.content };
  });
  if (!messages.some((m) => m.role === 'user')) throw new RequestError(400, 'invalid_messages');
  if (chars > app.maxInputChars) throw new RequestError(413, 'input_too_large');

  /** @type {number | undefined} */
  let maxTokens;
  if (raw.max_tokens !== undefined) {
    if (!Number.isInteger(raw.max_tokens) || raw.max_tokens < 1) throw new RequestError(400, 'invalid_max_tokens');
    maxTokens = Math.min(raw.max_tokens, app.maxOutputTokens);
  }

  /** @type {'json' | Record<string, unknown> | undefined} */
  let format;
  if (raw.format !== undefined) {
    if (!app.allowJson) throw new RequestError(403, 'format_not_allowed');
    const isSchema = raw.format !== null && typeof raw.format === 'object' && !Array.isArray(raw.format);
    if ((raw.format !== 'json' && !isSchema) || JSON.stringify(raw.format).length > MAX_FORMAT_CHARS) {
      throw new RequestError(400, 'invalid_format');
    }
    format = raw.format;
  }
  if (preset.requiresFormat && format === undefined) throw new RequestError(400, 'format_required');

  // Português com números dá ~3 caracteres por token; somamos a moldura de cada mensagem.
  // O Ollama corta o começo do texto quando passa do contexto, sem avisar: por isso recusamos antes.
  const estInputTokens = Math.ceil(chars / 3) + 16 * messages.length + 64;
  const outputTokens = Math.min(maxTokens ?? preset.maxTokens, app.maxOutputTokens);
  const numCtx = preset.numCtx ?? settings.numCtx; // a tarefa de análise roda com contexto maior
  if (estInputTokens + outputTokens > numCtx) throw new RequestError(413, 'context_too_large');

  return {
    task: /** @type {keyof typeof TASKS} */ (task),
    messages,
    maxTokens,
    format,
    stream: raw.stream === true,
    estInputTokens,
  };
}
