// @ts-check
/**
 * MAG AI — sonda de rede. Roda num container descartável ligado a UMA rede do MAG AI e prova o isolamento:
 *   --bloqueados host:porta ...   NÃO podem responder (bancos, serviços do servidor, internet)
 *   --relatar host:porta ...      só registra (portas que o servidor já abre para a internet)
 *   --nomes nome ...              NÃO podem resolver (containers de outros projetos)
 *   --esperados host:porta ...    TÊM de responder (controle positivo: prova que a sonda funciona)
 * Todas as conexões saem ao mesmo tempo, com 2 s de prazo. Sai com 1 se algo bloqueado responder,
 * algum nome resolver ou algum esperado não responder.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** @type {Record<string, string[]>} */
const listas = { bloqueados: [], relatar: [], nomes: [], esperados: [] };
let atual = 'bloqueados';
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--')) atual = arg.slice(2);
  else if (listas[atual]) listas[atual].push(arg);
}

/** @param {string} alvo */
function tenta(alvo) {
  const i = alvo.lastIndexOf(':');
  const host = alvo.slice(0, i);
  const port = Number(alvo.slice(i + 1));
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const fim = (/** @type {string} */ r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(2000, () => fim('sem resposta'));
    s.once('connect', () => fim('ABERTO'));
    s.once('error', (/** @type {any} */ e) => fim(e.code ?? 'erro'));
  });
}

let problemas = 0;
const [bloq, rel, esp] = await Promise.all([listas.bloqueados, listas.relatar, listas.esperados].map((l) => Promise.all(l.map(tenta))));
listas.bloqueados.forEach((a, i) => {
  if (bloq[i] === 'ABERTO') problemas += 1;
  console.log(`${bloq[i] === 'ABERTO' ? 'ALCANÇOU ' : 'bloqueado'} ${a} (${bloq[i]})`);
});
listas.relatar.forEach((a, i) => console.log(`${rel[i] === 'ABERTO' ? 'alcança (porta já pública)' : 'bloqueado'} ${a} (${rel[i]})`));
for (const nome of listas.nomes) {
  try {
    const r = await dns.lookup(nome);
    problemas += 1;
    console.log(`RESOLVEU  ${nome} -> ${r.address}`);
  } catch (e) {
    console.log(`não resolve ${nome} (${/** @type {any} */ (e).code ?? 'erro'})`);
  }
}
listas.esperados.forEach((a, i) => {
  if (esp[i] !== 'ABERTO') problemas += 1;
  console.log(`${esp[i] === 'ABERTO' ? 'responde (esperado)' : 'NÃO RESPONDE (esperado responder)'} ${a} (${esp[i]})`);
});
console.log(problemas ? `RESULTADO: ${problemas} problema(s)` : `RESULTADO: isolado (${listas.bloqueados.length} bloqueados, ${listas.nomes.length} nomes, ${listas.esperados.length} controles positivos)`);
process.exit(problemas ? 1 : 0);
