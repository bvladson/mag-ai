// @ts-check
/**
 * Mostra as métricas internas. Só funciona de dentro do container (a porta fica em 127.0.0.1):
 *   docker exec mag-ai-gateway node src/metricas.mjs
 */
const port = Number(process.env.MAG_AI_METRICS_PORT ?? 9090);
try {
  const r = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(3000) });
  process.stdout.write(`${await r.text()}\n`);
  process.exit(r.ok ? 0 : 1);
} catch {
  console.error('métricas indisponíveis');
  process.exit(1);
}
