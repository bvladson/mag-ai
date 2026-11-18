// @ts-check
/** Limite por minuto (balde de fichas) e cota diária por aplicação. Em memória: zera se o gateway reiniciar. */

const DAY_MS = 86_400_000;
/** Brasília = UTC−3, sem horário de verão desde 2019. */
const BRT_OFFSET_MS = 3 * 3_600_000;

/** @param {number} t milissegundos desde a época */
export function brazilDay(t) {
  return Math.floor((t - BRT_OFFSET_MS) / DAY_MS);
}

/** @param {number} t */
export function secondsToBrazilMidnight(t) {
  const next = (brazilDay(t) + 1) * DAY_MS + BRT_OFFSET_MS;
  return Math.max(1, Math.ceil((next - t) / 1000));
}

export class RateLimiter {
  /** @param {() => number} [now] */
  constructor(now = Date.now) {
    this.now = now;
    /** @type {Map<string, { tokens: number, last: number }>} */
    this.buckets = new Map();
    /** @type {Map<string, { day: number, count: number }>} */
    this.days = new Map();
  }

  /**
   * Consome uma ficha. A cota diária só conta pedidos aceitos.
   * @param {{ id: string, rpm: number, daily: number }} app
   * @returns {{ ok: boolean, reason: 'rpm' | 'daily' | null, retryAfterS: number }}
   */
  take(app) {
    const t = this.now();
    const day = brazilDay(t);
    let d = this.days.get(app.id);
    if (!d || d.day !== day) {
      d = { day, count: 0 };
      this.days.set(app.id, d);
    }
    if (d.count >= app.daily) return { ok: false, reason: 'daily', retryAfterS: secondsToBrazilMidnight(t) };

    let b = this.buckets.get(app.id);
    if (!b) {
      b = { tokens: app.rpm, last: t };
      this.buckets.set(app.id, b);
    }
    b.tokens = Math.min(app.rpm, b.tokens + ((t - b.last) * app.rpm) / 60_000);
    b.last = t;
    if (b.tokens < 1) {
      return { ok: false, reason: 'rpm', retryAfterS: Math.max(1, Math.ceil(((1 - b.tokens) * 60) / app.rpm)) };
    }
    b.tokens -= 1;
    d.count += 1;
    return { ok: true, reason: null, retryAfterS: 0 };
  }

  /** @param {string} appId */
  usedToday(appId) {
    const d = this.days.get(appId);
    return d && d.day === brazilDay(this.now()) ? d.count : 0;
  }
}
