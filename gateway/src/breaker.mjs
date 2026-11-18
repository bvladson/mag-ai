// @ts-check
/**
 * Disjuntor: depois de N falhas seguidas do Ollama, recusa na hora por um tempo (em vez de empilhar pedidos).
 * Passado o tempo, deixa um pedido tentar; se falhar de novo, reabre na primeira falha.
 */
export class Breaker {
  /** @param {{ failures?: number, openMs?: number, now?: () => number }} [options] */
  constructor({ failures = 3, openMs = 30_000, now = Date.now } = {}) {
    this.limit = failures;
    this.openMs = openMs;
    this.now = now;
    this.count = 0;
    this.openUntil = 0;
    this.tripped = false;
  }

  /** Segundos até poder tentar de novo (0 = pode tentar). */
  retryAfterS() {
    const left = this.openUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  success() {
    this.count = 0;
    this.openUntil = 0;
    this.tripped = false;
  }

  failure() {
    this.count += 1;
    if (this.tripped || this.count >= this.limit) {
      this.openUntil = this.now() + this.openMs;
      this.count = 0;
      this.tripped = true;
    }
  }

  /** @returns {'closed' | 'open' | 'half_open'} */
  get state() {
    if (this.retryAfterS() > 0) return 'open';
    return this.tripped ? 'half_open' : 'closed';
  }
}
