// @ts-check
/**
 * Gera a chave de uma aplicação: mostra a chave UMA vez (para o cofre da aplicação cliente)
 * e o SHA-256 (o único valor que vai para o apps.json do gateway).
 * Uso: node src/chave.mjs <id-da-aplicacao>
 */
import { newKey } from './auth.mjs';

const appId = process.argv[2];
if (!appId) {
  console.error('uso: node src/chave.mjs <id-da-aplicacao>');
  process.exit(2);
}
const { key, sha256 } = newKey(appId);
console.log(JSON.stringify({ app: appId, key, key_sha256: sha256 }, null, 2));
