// @ts-check
/**
 * Fila única: no máximo `slots` gerações ao mesmo tempo (1 nesta VPS) e uma espera curta e limitada.
 * Pedidos interativos passam à frente dos de lote. Quem desiste (cliente fechou) sai da fila.
 */

export class GateError extends Error {
  /** @param {'queue_full' | 'queue_timeout' | 'aborted'} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * @typedef {object} Waiting
 * @property {'interactive' | 'batch'} priority
 * @property {(release: () => void) => void} resolve
 * @property {(err: GateError) => void} reject
 * @property {() => void} leave
 */

export class Gate {
  /** @param {{ slots?: number, maxQueue?: number, maxWaitMs?: number }} [options] */
  constructor({ slots = 1, maxQueue = 4, maxWaitMs = 30_000 } = {}) {
    this.slots = slots;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.active = 0;
    /** @type {Waiting[]} */
    this.waiting = [];
  }

  get queued() {
    return this.waiting.length;
  }

  /**
   * @param {'interactive' | 'batch'} [priority]
   * @param {AbortSignal} [signal]
   * @returns {Promise<() => void>} função que libera a vaga (pode ser chamada mais de uma vez)
   */
  acquire(priority = 'interactive', signal) {
    if (signal?.aborted) return Promise.reject(new GateError('aborted'));
    if (this.active < this.slots && this.waiting.length === 0) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new GateError('queue_full'));

    return new Promise((resolve, reject) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const onAbort = () => {
        entry.leave();
        reject(new GateError('aborted'));
      };
      /** @type {Waiting} */
      const entry = {
        priority,
        resolve,
        reject,
        leave: () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      timer = setTimeout(() => {
        entry.leave();
        reject(new GateError('queue_timeout'));
      }, this.maxWaitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (priority === 'interactive') {
        const firstBatch = this.waiting.findIndex((e) => e.priority === 'batch');
        if (firstBatch === -1) this.waiting.push(entry);
        else this.waiting.splice(firstBatch, 0, entry);
      } else {
        this.waiting.push(entry);
      }
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.#next();
    };
  }

  #next() {
    while (this.active < this.slots && this.waiting.length > 0) {
      const entry = /** @type {Waiting} */ (this.waiting.shift());
      entry.leave();
      this.active += 1;
      entry.resolve(this.#releaser());
    }
  }
}
