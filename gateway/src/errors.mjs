// @ts-check
/** Códigos de erro estáveis (para as aplicações) e mensagens curtas em português (para mostrar a pessoas). */

export const MESSAGES = Object.freeze({
  invalid_request: 'Pedido inválido.',
  invalid_json: 'JSON inválido.',
  invalid_task: 'Tarefa desconhecida.',
  invalid_messages: 'Mensagens inválidas.',
  images_not_allowed: 'Imagens não são aceitas.',
  invalid_format: 'Formato de resposta inválido.',
  format_required: 'Esta tarefa exige um formato JSON.',
  invalid_max_tokens: 'max_tokens deve ser um inteiro positivo.',
  unauthorized: 'Chave ausente ou inválida.',
  task_not_allowed: 'Tarefa não liberada para esta aplicação.',
  format_not_allowed: 'Resposta em JSON não liberada para esta aplicação.',
  not_found: 'Rota inexistente.',
  method_not_allowed: 'Método não permitido.',
  payload_too_large: 'Pedido grande demais.',
  input_too_large: 'Texto acima do limite desta aplicação.',
  context_too_large: 'Texto grande demais para o contexto do modelo.',
  unsupported_media_type: 'Envie JSON (Content-Type: application/json).',
  rate_limited: 'Limite de pedidos por minuto atingido.',
  daily_quota: 'Cota diária atingida.',
  upstream_error: 'A IA não conseguiu responder.',
  busy: 'A IA está ocupada. Tente de novo em instantes.',
  upstream_unavailable: 'A IA está indisponível no momento.',
  timeout: 'A IA demorou demais para responder.',
  internal_error: 'Erro interno do gateway.',
});

/** @typedef {keyof typeof MESSAGES} ErrorCode */

export class RequestError extends Error {
  /**
   * @param {number} status
   * @param {ErrorCode} code
   * @param {number} [retryAfterS] vai no cabeçalho Retry-After
   */
  constructor(status, code, retryAfterS) {
    super(MESSAGES[code]);
    this.status = status;
    this.code = code;
    this.retryAfterS = retryAfterS ?? 0;
  }
}
