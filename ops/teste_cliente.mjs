// @ts-check
/**
 * MAG AI — testes de ponta a ponta. Roda num container descartável na rede mag-ai_biomie
 * (o mesmo lugar de onde o BIOMIE vai chamar). Usa SÓ dados fictícios.
 * Saída: uma linha "OK" ou "FALHA" por verificação e, no fim, "RESUMO {json}".
 */
const BASE = process.env.MAG_AI_URL ?? 'http://mag-ai:8080';
const KEY_HML = process.env.MAG_AI_KEY_HOMOLOGACAO ?? '';
const KEY_BIOMIE = process.env.MAG_AI_KEY_BIOMIE ?? '';

/** @type {{ verificacoes: {ok: boolean, nome: string}[], desempenho: object[], fila: object | null, limite: number[] | null, numeros_fora_dos_fatos: string[], qualidade: object | null }} */
const resumo = { verificacoes: [], desempenho: [], fila: null, limite: null, numeros_fora_dos_fatos: [], qualidade: null };
let falhas = 0;

/**
 * @param {boolean} ok
 * @param {string} nome
 * @param {string} [detalhe]
 */
function marca(ok, nome, detalhe = '') {
  if (!ok) falhas += 1;
  resumo.verificacoes.push({ ok, nome });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

/**
 * @param {string | null} key
 * @param {unknown} body
 * @param {{ path?: string, method?: string }} [opts]
 */
async function pedir(key, body, { path = '/v1/chat', method = 'POST' } = {}) {
  const t0 = Date.now();
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(180_000),
    });
    const text = await r.text();
    /** @type {any} */
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, json: { erro: err instanceof Error ? err.name : 'erro' }, ms: Date.now() - t0 };
  }
}

const FATOS = [
  'DADOS FICTÍCIOS DE TESTE (não são da MAG).',
  'Empresa: Exemplo Móveis.',
  'Faturamento de outubro/2026: R$ 412.350,00.',
  'Faturamento de setembro/2026: R$ 389.120,00. Outubro ficou 6,0% acima de setembro.',
  'Meta de outubro/2026: R$ 450.000,00. Atingido: 91,6%.',
  'Pedidos em outubro: 37. Ticket médio: R$ 11.144,59.',
  'Maior vendedora: Ana, com R$ 158.900,00 (38,5% do total).',
  'Clientes novos em outubro: 5.',
].join('\n');
const SISTEMA = [
  'Você é o assistente comercial do BIOMIE. Responda em português do Brasil, em no máximo 5 frases curtas.',
  'Use SOMENTE os números que aparecem nos FATOS, escritos exatamente como estão. Não invente números, nomes, causas ou datas.',
  'Se a pergunta não puder ser respondida com os FATOS, diga que não há dados suficientes.',
].join('\n');

/**
 * @param {string} pergunta
 * @param {string} [prefixo] muda o começo do texto para o Ollama não reaproveitar a leitura anterior
 */
const msgs = (pergunta, prefixo = '') => [
  { role: 'system', content: `${prefixo}${SISTEMA}` },
  { role: 'user', content: `FATOS:\n${FATOS}\n\nPERGUNTA: ${pergunta}` },
];

/** Números da resposta que não aparecem nos fatos (sinal de invenção; avaliado na homologação). @param {string} texto */
function numerosForaDosFatos(texto) {
  const norm = (/** @type {string} */ s) => s.replace(/[^\d,]/g, '').replace(/,$/, '');
  const dosFatos = new Set((FATOS.match(/\d[\d.]*(,\d+)?/g) ?? []).map(norm));
  return [...new Set((texto.match(/\d[\d.]*(,\d+)?/g) ?? []).map(norm))].filter((n) => n && !dosFatos.has(n));
}

/** @param {number} n */
const r1 = (n) => Math.round(n * 10) / 10;

// 1. Saúde
const saude = await pedir(null, null, { path: '/v1/health', method: 'GET' });
marca(saude.status === 200 && saude.json?.ollama === 'up', 'saúde: gateway e Ollama no ar', JSON.stringify(saude.json));

// 2. Segurança
marca((await pedir(null, { task: 'explicar', messages: msgs('x') })).status === 401, 'sem chave: 401');
marca((await pedir(`magai_biomie_${'A'.repeat(43)}`, { task: 'explicar', messages: msgs('x') })).status === 401, 'chave inventada: 401');
for (const [method, path] of [['GET', '/api/tags'], ['POST', '/api/pull'], ['POST', '/api/generate'], ['GET', '/api/ps'], ['DELETE', '/api/delete']]) {
  const r = await pedir(KEY_HML, {}, { path, method });
  marca(r.status === 404, `API do Ollama não passa pelo gateway: ${method} ${path} → ${r.status}`);
}
let direto = 'acessível';
try {
  await fetch('http://mag-ai-ollama:11434/api/version', { signal: AbortSignal.timeout(3000) });
} catch {
  direto = 'inacessível';
}
marca(direto === 'inacessível', 'Ollama direto inacessível a partir da rede do BIOMIE');
let internet = 'acessível';
try {
  await fetch('https://registry.ollama.ai/v2/', { signal: AbortSignal.timeout(5000) });
} catch {
  internet = 'inacessível';
}
marca(internet === 'inacessível', 'rede do BIOMIE com a IA não tem saída para a internet');
const imagem = await pedir(KEY_HML, { task: 'explicar', messages: [{ role: 'user', content: 'veja', images: ['AAAA'] }] });
marca(imagem.status === 400 && imagem.json?.error?.code === 'images_not_allowed', 'imagem recusada: 400');
const grande = await pedir(KEY_HML, { task: 'explicar', messages: [{ role: 'user', content: 'x'.repeat(70_000) }] });
marca(grande.status === 413, 'pedido grande demais: 413');

// 3. Função
const explicar = await pedir(KEY_HML, { task: 'explicar', max_tokens: 220, messages: msgs('Explique o desempenho de outubro em relação à meta e a setembro.') });
const textoExplicar = String(explicar.json?.content ?? '');
marca(explicar.status === 200 && textoExplicar.trim().length > 20, 'explicar: resposta gerada', `${explicar.ms} ms`);
if (textoExplicar) {
  console.log(`      resposta: ${textoExplicar.replace(/\s+/g, ' ').slice(0, 600)}`);
  resumo.numeros_fora_dos_fatos.push(...numerosForaDosFatos(textoExplicar));
}

const esquema = {
  type: 'object',
  properties: {
    intencao: { type: 'string', enum: ['faturamento_periodo', 'comparar_periodos', 'ranking_vendedores', 'fora_do_escopo'] },
    periodo: { type: 'string' },
  },
  required: ['intencao'],
};
const classificar = await pedir(KEY_HML, {
  task: 'classificar',
  format: esquema,
  messages: [
    { role: 'system', content: 'Classifique a pergunta do usuário. Responda só com o JSON pedido.' },
    { role: 'user', content: 'Quanto vendemos em outubro comparado com setembro?' },
  ],
});
/** @type {string | null} */
let intencao = null;
try {
  intencao = JSON.parse(String(classificar.json?.content ?? '')).intencao;
} catch {
  intencao = null;
}
marca(
  classificar.status === 200 && esquema.properties.intencao.enum.includes(String(intencao)),
  'classificar: JSON válido dentro do esquema',
  `intenção=${intencao}; ${classificar.ms} ms`,
);

{
  const t0 = Date.now();
  /** @type {number | null} */
  let primeiro = null;
  let texto = '';
  /** @type {any} */
  let fim = null;
  let status = 0;
  try {
    const r = await fetch(`${BASE}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY_HML}` },
      body: JSON.stringify({ task: 'resumir', stream: true, max_tokens: 120, messages: msgs('Resuma outubro em 2 frases.') }),
      signal: AbortSignal.timeout(180_000),
    });
    status = r.status;
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (r.body?.getReader());
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'delta') {
          if (primeiro === null) primeiro = Date.now() - t0;
          texto += ev.content;
        } else {
          fim = ev;
        }
      }
    }
  } catch {
    status = status || 0;
  }
  marca(status === 200 && fim?.type === 'done' && texto.length > 0, 'resumir em streaming', `primeira palavra em ${primeiro} ms; total ${Date.now() - t0} ms`);
}

// 3b. Qualidade (medição; não reprova a instalação): perguntas com resposta nos fatos, perguntas fora dos fatos
//     (a IA deve dizer que não há dados) e classificação de intenção com esquema JSON.
{
  const recusa = /não h[áa] (dados|informa)|não tenho|não consta|não (é|e) poss[íi]vel|sem dados|não aparece|não (est[áa]|estão) (dispon|nos fatos)/i;
  const casos = [
    { pergunta: 'Quanto faturamos em outubro?', espera: ['412.350'] },
    { pergunta: 'Batemos a meta de outubro?', espera: ['91,6', '450.000'] },
    { pergunta: 'Como outubro se compara com setembro?', espera: ['6,0', '389.120'] },
    { pergunta: 'Quem vendeu mais em outubro?', espera: ['Ana'] },
    { pergunta: 'Qual foi o ticket médio de outubro?', espera: ['11.144,59'] },
    { pergunta: 'Quantos clientes novos tivemos em outubro?', espera: ['5'] },
    { pergunta: 'Qual foi o faturamento de dezembro de 2025?', espera: [], recusar: true },
    { pergunta: 'Qual foi a margem de lucro de outubro?', espera: [], recusar: true },
  ];
  const respostas = [];
  for (const c of casos) {
    const r = await pedir(KEY_HML, { task: 'responder', max_tokens: 160, messages: msgs(c.pergunta) });
    const texto = String(r.json?.content ?? '');
    const inventados = numerosForaDosFatos(texto);
    const certa = r.status === 200 && inventados.length === 0 && (c.recusar ? recusa.test(texto) : c.espera.some((e) => texto.includes(e)));
    const curto = texto.replace(/\s+/g, ' ').slice(0, 400);
    respostas.push({ pergunta: c.pergunta, tipo: c.recusar ? 'fora dos fatos' : 'nos fatos', certa, status: r.status, ms: r.ms, inventados, resposta: curto });
    console.log(`QUALIDADE ${certa ? 'certa ' : 'errada'} (${c.recusar ? 'deveria recusar' : 'nos fatos'}; ${r.ms} ms) ${c.pergunta} -> ${curto.slice(0, 300)}`);
  }
  const intencoes = [
    ['Quanto vendemos em outubro?', 'faturamento_periodo'],
    ['Me mostre o faturamento de setembro.', 'faturamento_periodo'],
    ['Outubro foi melhor que setembro?', 'comparar_periodos'],
    ['Compare o terceiro trimestre com o segundo.', 'comparar_periodos'],
    ['Quem são os melhores vendedores do mês?', 'ranking_vendedores'],
    ['Qual a previsão do tempo para amanhã?', 'fora_do_escopo'],
  ];
  let acertos = 0;
  const classificacoes = [];
  for (const [pergunta, esperado] of intencoes) {
    const r = await pedir(KEY_HML, {
      task: 'classificar',
      format: esquema,
      messages: [
        { role: 'system', content: 'Classifique a pergunta do usuário em uma das intenções do esquema. Responda só com o JSON.' },
        { role: 'user', content: pergunta },
      ],
    });
    /** @type {string | null} */
    let obtido = null;
    try {
      obtido = JSON.parse(String(r.json?.content ?? '')).intencao;
    } catch {
      obtido = null;
    }
    if (obtido === esperado) acertos += 1;
    classificacoes.push({ pergunta, esperado, obtido, ms: r.ms });
    console.log(`QUALIDADE ${obtido === esperado ? 'certa ' : 'errada'} (classificar; ${r.ms} ms) ${pergunta} -> ${obtido} (esperado ${esperado})`);
  }
  const certas = respostas.filter((x) => x.certa).length;
  resumo.qualidade = { respostas_certas: certas, respostas_total: respostas.length, classificacao_certa: acertos, classificacao_total: intencoes.length, respostas, classificacoes };
  console.log(`QUALIDADE resumo: respostas certas ${certas}/${respostas.length}; classificação ${acertos}/${intencoes.length}`);
}

// 4. Desempenho: 3 rodadas "frias" (texto novo) + 2 "mornas" (mesmo começo de texto, como no uso real)
for (let i = 1; i <= 5; i += 1) {
  const fria = i <= 3;
  const prefixo = fria ? `Pedido de teste ${i} (${Date.now()}).\n` : 'Pedido de teste fixo.\n';
  const b = await pedir(KEY_HML, { task: 'explicar', max_tokens: 200, messages: msgs('Explique o desempenho de outubro em relação à meta e a setembro.', prefixo) });
  if (b.status !== 200) {
    marca(false, `desempenho rodada ${i}`, `status ${b.status}`);
    continue;
  }
  const t = b.json.timings;
  const u = b.json.usage;
  const linha = {
    rodada: i,
    tipo: fria ? 'fria' : 'morna',
    total_ms: b.ms,
    carga_ms: t.load_ms,
    leitura_ms: t.prompt_ms,
    geracao_ms: t.generate_ms,
    tokens_entrada: u.prompt_tokens,
    tokens_saida: u.output_tokens,
    leitura_tok_s: t.prompt_ms ? r1(u.prompt_tokens / (t.prompt_ms / 1000)) : null,
    geracao_tok_s: t.generate_ms ? r1(u.output_tokens / (t.generate_ms / 1000)) : null,
  };
  resumo.desempenho.push(linha);
  console.log(
    `      rodada ${i} (${linha.tipo}): total ${b.ms} ms | carga ${t.load_ms} ms | leitura ${u.prompt_tokens} tok em ${t.prompt_ms} ms | geração ${u.output_tokens} tok em ${t.generate_ms} ms`,
  );
  resumo.numeros_fora_dos_fatos.push(...numerosForaDosFatos(String(b.json.content ?? '')));
}
marca(resumo.desempenho.length === 5, 'desempenho: 5 rodadas medidas');

// 5. Fila: 6 pedidos ao mesmo tempo (1 roda, até 4 esperam, o resto recebe 503 "ocupado")
{
  const t0 = Date.now();
  const paralelos = await Promise.all(
    Array.from({ length: 6 }, (_, i) => pedir(KEY_HML, { task: 'resumir', max_tokens: 60, messages: msgs(`Resuma outubro em 1 frase. (pedido ${i})`) })),
  );
  const status = paralelos.map((p) => p.status);
  resumo.fila = { status, tempo_total_ms: Date.now() - t0, espera_ms: paralelos.map((p) => p.json?.timings?.queue_ms ?? null) };
  marca(
    status.every((s) => s === 200 || s === 503) && status.includes(200) && status.includes(503),
    'fila: uma geração por vez; excedente recebe 503 (sem erro)',
    `status ${status.join(',')}; ${Date.now() - t0} ms`,
  );
}

// 6. Limite por minuto da aplicação biomie (6/min): 7 pedidos juntos → exatamente um 429
{
  const sete = await Promise.all(
    Array.from({ length: 7 }, (_, i) => pedir(KEY_BIOMIE, { task: 'responder', max_tokens: 1, messages: [{ role: 'user', content: `Diga ok. (${i})` }] })),
  );
  resumo.limite = sete.map((p) => p.status);
  marca(resumo.limite.filter((s) => s === 429).length === 1, 'limite da aplicação biomie (6 por minuto): o 7º recebe 429', resumo.limite.join(','));
}

// 7. Saúde depois da carga
const depois = await pedir(null, null, { path: '/v1/health', method: 'GET' });
marca(depois.status === 200 && depois.json?.status === 'ok', 'saúde depois da carga', JSON.stringify(depois.json));

resumo.numeros_fora_dos_fatos = [...new Set(resumo.numeros_fora_dos_fatos)];
console.log(`RESUMO ${JSON.stringify(resumo)}`);
process.exit(falhas ? 1 : 0);
