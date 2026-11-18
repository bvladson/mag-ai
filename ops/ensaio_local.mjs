// @ts-check
/**
 * Ensaio local do teste de ponta a ponta (ops/teste_cliente.mjs) contra o gateway REAL e um Ollama de mentira.
 * Serve para validar o próprio teste antes de levá-lo à VPS. Uso: node ops/ensaio_local.mjs
 * Esperado aqui: tudo OK, menos "sem saída para a internet" (este computador tem internet; na VPS a rede é interna).
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newKey } from '../gateway/src/auth.mjs';
import { loadSettings, parseApps } from '../gateway/src/config.mjs';
import { createGateway } from '../gateway/src/server.mjs';

const MODELO = 'qwen3.5:0.8b-q8_0';
const aqui = path.dirname(fileURLToPath(import.meta.url));

/** @param {http.Server} s */
const ouvir = (s) =>
  new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (s.address()).port)));

const ollama = http.createServer(async (req, res) => {
  if (req.url === '/api/ps') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: MODELO, model: MODELO }] }));
  }
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const pedacos = body.format
    ? ['{"intencao":', '"comparar_periodos"}']
    : ['Em outubro o faturamento foi de R$ 412.350,00, ', '91,6% da meta de R$ 450.000,00 ', 'e 6,0% acima de setembro.'];
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const p of pedacos) {
    await new Promise((r) => setTimeout(r, 60));
    if (res.destroyed) return;
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: p }, done: false })}\n`);
  }
  res.end(
    `${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 310, eval_count: 40, load_duration: 1e6, prompt_eval_duration: 9e8, eval_duration: 1.6e9 })}\n`,
  );
});
const portaOllama = await ouvir(ollama);

const kb = newKey('biomie');
const kh = newKey('homologacao');
const apps = parseApps({
  apps: [
    { id: 'biomie', key_sha256: kb.sha256, tasks: ['explicar', 'resumir', 'responder', 'classificar'], rpm: 6, daily: 300, max_input_chars: 4500, max_output_tokens: 400, timeout_s: 60, allow_json: true },
    { id: 'homologacao', key_sha256: kh.sha256, tasks: ['explicar', 'resumir', 'responder', 'classificar'], rpm: 60, daily: 500, max_input_chars: 4500, max_output_tokens: 400, timeout_s: 120, priority: 'batch', allow_json: true },
  ],
});
const settings = loadSettings({ MAG_AI_MODEL: MODELO, OLLAMA_URL: `http://127.0.0.1:${portaOllama}` });
/** @type {string[]} */
const logs = [];
const gw = createGateway({ settings, apps, log: (e, f) => logs.push(JSON.stringify({ e, ...f })) });
const portaGw = await ouvir(gw.api);

const filho = spawn(process.execPath, [path.join(aqui, 'teste_cliente.mjs')], {
  env: { ...process.env, MAG_AI_URL: `http://127.0.0.1:${portaGw}`, MAG_AI_KEY_HOMOLOGACAO: kh.key, MAG_AI_KEY_BIOMIE: kb.key },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let saida = '';
filho.stdout.on('data', (d) => (saida += d));
const codigo = await new Promise((r) => filho.on('close', r));
process.stdout.write(saida.split('\n').filter((l) => !l.startsWith('RESUMO ')).join('\n'));
const resumo = JSON.parse(saida.split('\n').find((l) => l.startsWith('RESUMO '))?.slice(7) ?? '{}');
const falhas = resumo.verificacoes.filter((/** @type {any} */ v) => !v.ok).map((/** @type {any} */ v) => v.nome);
console.log(`\ncódigo de saída do teste: ${codigo}; falhas: ${JSON.stringify(falhas)}`);
console.log(`fila: ${JSON.stringify(resumo.fila?.status)}; limite: ${JSON.stringify(resumo.limite)}; números fora dos fatos: ${JSON.stringify(resumo.numeros_fora_dos_fatos)}`);
const conteudoNosLogs = logs.some((l) => l.includes('412.350') || l.includes(kb.key) || l.includes(kh.key));
console.log(`logs do gateway: ${logs.length} linhas; algum texto ou chave nos logs? ${conteudoNosLogs ? 'SIM (ERRO)' : 'não'}`);
const esperado = falhas.length === 1 && falhas[0].includes('internet') && !conteudoNosLogs;
console.log(esperado ? 'ENSAIO OK (a única falha é a da internet, esperada fora da VPS)' : 'ENSAIO COM PROBLEMA');
gw.api.closeAllConnections();
gw.api.close();
ollama.closeAllConnections();
ollama.close();
process.exit(esperado ? 0 : 1);
