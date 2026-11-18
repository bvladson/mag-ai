// @ts-check
/**
 * Chaves por aplicação. Formato: magai_<aplicação>_<43 caracteres base64url = 32 bytes aleatórios>.
 * O gateway só guarda o SHA-256 da chave. Como a chave tem 256 bits aleatórios, SHA-256 simples basta
 * (não é senha escolhida por pessoa).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_ID } from './config.mjs';

const KEY_FORMAT = /^magai_[a-z][a-z0-9-]{1,31}_[A-Za-z0-9_-]{43}$/;

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** @param {string} appId */
export function newKey(appId) {
  if (!APP_ID.test(appId)) throw new Error('id de aplicação inválido (use a-z, 0-9 e hífen)');
  const key = `magai_${appId}_${randomBytes(32).toString('base64url')}`;
  return { key, sha256: sha256(key).toString('hex') };
}

/**
 * Devolve a aplicação dona da chave, ou null. Compara com todas as aplicações (tempo constante por item).
 * @template {{ keyHash: Buffer }} T
 * @param {readonly T[]} apps
 * @param {unknown} header valor do cabeçalho Authorization
 * @returns {T | null}
 */
export function authenticate(apps, header) {
  if (typeof header !== 'string' || header.length > 200) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match || !KEY_FORMAT.test(match[1])) return null;
  const digest = sha256(match[1]);
  /** @type {T | null} */
  let found = null;
  for (const app of apps) {
    if (timingSafeEqual(digest, app.keyHash)) found = app;
  }
  return found;
}
