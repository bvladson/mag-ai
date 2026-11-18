// @ts-check
/** Conversa com o Ollama (/api/chat, sempre em streaming do lado de dentro). */
import { TASKS } from './config.mjs';

export class UpstreamError extends Error {
  /** @param {'upstream_error' | 'upstream_bad_response' | 'upstream_incomplete'} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Modelo que a tarefa usa: o segundo modelo (análise) quando o preset pede e ele está configurado.
 * @param {import('./config.mjs').Settings} settings
 * @param {keyof typeof TASKS} task
 */
export function modelFor(settings, task) {
  const preset = TASKS[task];
  return preset.model === 'analise' && settings.modelAnalise ? settings.modelAnalise : settings.model;
}

/**
 * Monta o pedido ao Ollama só com campos conhecidos: o cliente não escolhe modelo, contexto,
 * threads, tempo de permanência na memória nem modo de raciocínio — a TAREFA escolhe (config.mjs).
 * O raciocínio (message.thinking) nunca é repassado: o leitor abaixo só entrega message.content.
 * @param {import('./config.mjs').Settings} settings
 * @param {import('./config.mjs').AppPolicy} app
 * @param {import('./validate.mjs').ChatInput} input
 */
export function buildChatBody(settings, app, input) {
  const preset = TASKS[input.task];
  /** @type {Record<string, unknown>} */
  const body = {
    model: modelFor(settings, input.task),
    messages: input.messages,
    stream: true,
    think: preset.think === true,
    keep_alive: settings.keepAlive,
    options: {
      num_ctx: preset.numCtx ?? settings.numCtx,
      num_thread: settings.numThread,
      num_predict: Math.min(input.maxTokens ?? preset.maxTokens, app.maxOutputTokens),
      temperature: preset.temperature,
      top_p: settings.topP,
      top_k: settings.topK,
      presence_penalty: settings.presencePenalty,
    },
  };
  if (input.format !== undefined) body.format = input.format;
  return body;
}

/** @param {unknown} v nanossegundos */
const nsToMs = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v / 1e6) : 0);

/**
 * Lê o NDJSON do Ollama e entrega cada pedaço de texto a onDelta.
 * @param {AsyncIterable<Uint8Array>} stream
 * @param {(text: string) => void} onDelta
 */
export async function readChatStream(stream, onDelta) {
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {any} */
  let final = null;
  /** @param {string} line */
  const handle = (line) => {
    if (!line.trim()) return;
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new UpstreamError('upstream_bad_response');
    }
    if (msg && typeof msg.error === 'string') throw new UpstreamError('upstream_error');
    const text = msg?.message?.content;
    if (typeof text === 'string' && text.length > 0) onDelta(text);
    if (msg?.done === true) final = msg;
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  handle(buffer);
  if (!final) throw new UpstreamError('upstream_incomplete');
  return {
    doneReason: typeof final.done_reason === 'string' ? final.done_reason : null,
    promptTokens: Number(final.prompt_eval_count) || 0,
    outputTokens: Number(final.eval_count) || 0,
    loadMs: nsToMs(final.load_duration),
    promptMs: nsToMs(final.prompt_eval_duration),
    generateMs: nsToMs(final.eval_duration),
  };
}
