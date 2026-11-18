// @ts-check
/** Contadores por aplicação e janela dos últimos 5 minutos. Só números e códigos: nenhum texto de pedido. */

const KEEP = 500;

/**
 * @param {number[]} sorted
 * @param {number} p
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export class Metrics {
  /**
   * @param {string[]} appIds
   * @param {() => number} [now]
   */
  constructor(appIds, now = Date.now) {
    this.now = now;
    this.startedAt = now();
    /** @type {Map<string, { requests: number, ok: number, codes: Record<string, number>, prompt_tokens: number, output_tokens: number }>} */
    this.totals = new Map(appIds.map((id) => [id, { requests: 0, ok: 0, codes: {}, prompt_tokens: 0, output_tokens: 0 }]));
    /** @type {{ t: number, status: number, code: string | null, ms: number }[]} */
    this.recent = [];
  }

  /**
   * @param {string} appId
   * @param {{ status: number, code: string | null, totalMs: number, promptTokens: number, outputTokens: number }} e
   */
  record(appId, e) {
    const tot = this.totals.get(appId);
    if (!tot) return;
    tot.requests += 1;
    if (e.status === 200) tot.ok += 1;
    else if (e.code) tot.codes[e.code] = (tot.codes[e.code] ?? 0) + 1;
    tot.prompt_tokens += e.promptTokens;
    tot.output_tokens += e.outputTokens;
    this.recent.push({ t: this.now(), status: e.status, code: e.code, ms: e.totalMs });
    if (this.recent.length > KEEP) this.recent.shift();
  }

  /** @param {Record<string, unknown>} [extra] */
  snapshot(extra = {}) {
    const t = this.now();
    const last = this.recent.filter((r) => t - r.t <= 300_000);
    const okMs = last.filter((r) => r.status === 200).map((r) => r.ms).sort((a, b) => a - b);
    return {
      uptime_s: Math.round((t - this.startedAt) / 1000),
      last_5min: {
        requests: last.length,
        ok: okMs.length,
        errors_5xx: last.filter((r) => r.status >= 500).length,
        busy: last.filter((r) => r.code === 'busy').length,
        rate_limited: last.filter((r) => r.status === 429).length,
        timeouts: last.filter((r) => r.code === 'timeout').length,
        p50_ms: percentile(okMs, 50),
        p95_ms: percentile(okMs, 95),
      },
      apps: Object.fromEntries([...this.totals].map(([id, v]) => [id, { ...v, codes: { ...v.codes } }])),
      ...extra,
    };
  }
}
