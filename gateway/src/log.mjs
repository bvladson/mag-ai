// @ts-check
/**
 * Uma linha JSON por evento, na saída padrão (o Docker guarda com rotação 10 MB x 3).
 * Quem chama passa só metadados: aplicação, tarefa, status, tempos e contagens de tokens. Nunca texto.
 * @param {(line: string) => void} [write]
 * @returns {(event: string, fields?: Record<string, unknown>) => void}
 */
export function makeLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  return (event, fields = {}) => write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
