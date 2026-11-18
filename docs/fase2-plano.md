# MAG AI — Fase 2: planejamento (05/11/2026)

> **Atualização 05/11, tarde (parecer):** D1 e D2 aprovadas conceitualmente; D3 validada (`d3-validacao-dockerfile.md`);
> D4 ajustada para contexto 2.048, fila de 2 e descarga após 2 min; D5 aprovada; execução trocada pelo usuário para a madrugada de sábado 07/11, 00:30–01:30.
> Checklist final, roteiro e critérios de parada em `fase3-checklist-e-roteiro.md`. As tabelas abaixo já usam os valores novos.

Base: diagnóstico da Fase 1 (`fase1-diagnostico-20261105.md`). Nada foi instalado. Os arquivos de implantação
estão prontos e testados localmente neste projeto (`deploy/`, `gateway/`, `ops/`, `srv/`).

## 1. Decisões que dependem do usuário

| # | decisão | recomendação |
|---|---|---|
| D1 | Onde integrar | No **BIOMIE v2** (TypeScript, produção). O repositório `bvladson/biomie` é o PHP antigo em desativação. O cliente PHP fica para os sistemas PHP (SCF, tarefas, sites), quando forem integrados |
| D2 | Modelo | `qwen3.5:0.8b-q8_0`: os **mesmos pesos** da tag `qwen3.5:0.8b`, sem o modelo auxiliar de 303 MB, com conteúdo fixo e conferido. A `0.8b` com o auxiliar é medida na homologação |
| D3 | Imagem do Ollama | Imagem só com CPU (~0,3 GB) montada do pacote oficial conferido por SHA256, em vez da oficial (3,4 GB comprimidos, com CUDA) |
| D4 | Limites | 2,5 GB sem swap, 1 vCPU com prioridade menor, 1 geração por vez, fila de 4, contexto de 4096, descarrega após 15 min |
| D5 | Janela da Fase 3 | Sábado 07/11 a partir das 12:30 ou domingo 08/11. Fora das noites de 05/11 (ativação do BIOMIE) e 06/11 (passo 2 do legado). Duração ~30 min; reversão em ~1 min |

## 2. Modelo

- Tag `qwen3.5:0.8b` **confirmada** na biblioteca oficial do Ollama (ollama.com/library/qwen3.5), licença Apache 2.0,
  exige Ollama ≥ 0.30.0. Modelo de 752 milhões de parâmetros, quantização Q8_0, aceita texto e imagem, tem modo de
  raciocínio ("thinking") e janela de 256K tokens.
- Conteúdo da tag `0.8b`: modelo Q8_0 (812 MB) + módulo de visão (207 MB) + modelo auxiliar de aceleração (303 MB).
  O manifesto dela varia conforme o cliente (o digest do site, `6a061203ed02`, não bate com o que o registro entrega
  sem assinatura).
- Conteúdo da tag `0.8b-q8_0`: o **mesmo** modelo Q8_0 (camada `889ea3b9…`) + o mesmo módulo de visão (`5ba2eb9b…`),
  sem o auxiliar. Manifesto fixo: sha256 `7c00f78aed0f…` (bate com o site). Guardado em `deploy/modelo/`.
- Ajustes por pedido (impostos pelo gateway): raciocínio desligado (`think: false`), contexto 4096, 1 thread,
  temperatura 0,2–0,3 (0 para classificar), `top_p` 0,8, `top_k` 20, teto de resposta por tarefa (160–350 tokens).
  O padrão do modelo (temperatura 1, `presence_penalty` 1,5) é para conversa livre; para números, temperatura baixa.
- Imagens: recusadas pelo gateway (gasto de CPU e superfície de ataque sem uso no BIOMIE).
- Limite de qualidade: um modelo de 0,8B escreve bem frases curtas a partir de fatos prontos, mas erra contas,
  comparações e números quando precisa deduzir. Por isso **o BIOMIE calcula tudo e o modelo só redige** (seção 6).

## 3. Arquitetura

```
                 Internet ──► nginx (80/443, sem mudança) ──► BIOMIE web (127.0.0.1:3130)
                                                                  │  funções de servidor
                                                                  │  (sessão do usuário, RLS)
   rede mag-ai_biomie (interna, sem internet) ────────────────────┤
                                                                  ▼
                                                     mag-ai-gateway :8080
                                                     chave por aplicação, tarefas
                                                     liberadas, limites, fila única,
                                                     prazos, logs sem conteúdo
   rede mag-ai_interna (interna, sem internet) ───────────────────┤
                                                                  ▼
                                                     mag-ai-ollama :11434
                                                     qwen3.5:0.8b-q8_0, só CPU,
                                                     2,5 GB / 1 vCPU, sem nuvem
                                                     volume mag-ai_modelos
```

- **Nenhuma porta no servidor.** O Ollama só é alcançável pelo gateway; o gateway só pelas redes internas dos clientes.
- **Uma rede por aplicação cliente** (`mag-ai_biomie`, depois `mag-ai_crm`, `mag-ai_logistica`…): uma aplicação
  não enxerga a outra, e nenhuma enxerga o Ollama.
- **Sem internet** nas duas redes, e **sem endereço do servidor na ponte** (`inhibit_ipv4`): o container só fala com container. O modelo é baixado uma vez por uma rede temporária (`mag-ai_saida`), removida
  logo depois, e conferido camada a camada. `OLLAMA_NO_CLOUD=1` desliga a nuvem também na configuração.
- Projeto Docker próprio (`mag-ai`), pastas `/opt/mag-ai` e `/srv/mag-ai` e manifesto, como os outros projetos.

### Contrato do gateway (v1)

`POST /v1/chat` com `Authorization: Bearer <chave da aplicação>`:

```json
{ "task": "explicar | resumir | responder | classificar",
  "messages": [{ "role": "system | user | assistant", "content": "..." }],
  "max_tokens": 300, "format": { "...esquema JSON (só classificar)..." }, "stream": false }
```

Resposta: `content`, `done_reason`, `usage` (tokens) e `timings` (fila, carga, leitura, geração). Com
`stream: true`, NDJSON (`delta` … `done`). Erros com código estável: 401 chave, 403 tarefa não liberada,
413 grande demais, 429 limite (com `Retry-After`), 503 ocupado/indisponível (com `Retry-After`), 504 prazo.
`GET /v1/health` para saber se a IA está no ar. Métricas só por dentro do container.

## 4. Limites

| item | valor | por quê |
|---|---|---|
| memória do Ollama | 2.560 MB, **sem swap** | teto pedido; esperado 1,2–1,6 GB; se passar, cai só a IA |
| CPU do Ollama | 1,0 vCPU, prioridade menor (`cpu_shares` 512) | metade da máquina no máximo; cede em disputa |
| gerações simultâneas | 1 (`OLLAMA_NUM_PARALLEL=1` + fila do gateway) | 2 vCPUs |
| fila | 2 esperando, até 30 s; o resto recebe 503 "ocupado" | sem acúmulo (D4) |
| modelos carregados | 1 (`OLLAMA_MAX_LOADED_MODELS=1`; o padrão em CPU é 3) | memória |
| contexto | 2.048 tokens na homologação (o modelo aceita 256K) | memória e tempo (D4); amplia conforme resultados |
| permanência | 2 min sem uso → sai da memória | devolve a RAM logo (D4) |
| texto de entrada | até 4.500 caracteres por pedido (BIOMIE); recusa antes de o Ollama cortar | o Ollama corta o começo sem avisar |
| BIOMIE | 6 pedidos/min, 300/dia, prazo 60 s | ajustável no `apps.json` sem trocar código |
| gateway | 192 MB, 0,25 vCPU | |
| prioridade se faltar memória no servidor | IA cai primeiro (`oom_score_adj` 500) | protege bancos e sites |

## 5. Segurança

- Containers sem root, sistema de arquivos só leitura, sem capacidades (`cap_drop: ALL`), `no-new-privileges`,
  limite de processos.
- Chave por aplicação com 256 bits aleatórios; o gateway guarda só o SHA-256 (`/opt/mag-ai/config/apps.json`);
  a chave em texto fica em `/srv/mag-ai/CREDENCIAIS.txt` (600) e no cofre da aplicação cliente.
- Cada aplicação tem tarefas liberadas, limite por minuto, cota diária, teto de texto e prazo próprios.
- O gateway só repassa campos conhecidos: a aplicação não escolhe modelo, contexto, threads nem modo de raciocínio,
  e não alcança a API administrativa do Ollama (`/api/pull`, `/api/delete`, `/api/create`…).
- Logs com aplicação, tarefa, status, tempos e contagem de tokens. **Nunca** o texto do pedido, da resposta ou a chave
  (teste automático cobre isso).
- Versões fixadas: Ollama 0.40.14 (pacote conferido por SHA256 contra o valor fixado e contra o `sha256sum.txt` da
  release), imagens base por digest, modelo por camadas.
- Fora do escopo do MAG AI e sem mudança: nginx, firewall, daemon do Docker, bancos e containers de outros projetos.

## 6. Integração ao BIOMIE v2 (Fase 4, branch separada)

Princípio: **a IA não acessa o banco.** O BIOMIE calcula os indicadores com as funções que as telas já usam, com a
sessão do usuário (RLS), monta um bloco de fatos e pede ao modelo só a redação.

1. **Cliente** `src/lib/ai/mag-ai.server.ts`: chamada ao gateway com prazo (45 s), cancelamento, disjuntor, sem log de
   conteúdo; chave só no servidor (`MAG_AI_KEY` no `stack.env`).
2. **Serviço de inteligência** `src/lib/ai.functions.ts` (`createServerFn` + `requireSupabaseAuth`):
   - `explicarPainel`: lê resumo, evolução e principais quebras do período já filtrado na tela → fatos formatados em
     pt-BR (valores, variações e posições já calculados) → texto de 3–5 frases.
   - `perguntar`: pergunta em linguagem natural → **catálogo fechado de intenções** (faturamento do período,
     comparação de períodos, ranking de vendedores, clientes ou produtos, ritmo do Plano de Voo, estoque parado,
     oportunidades) → primeiro regras simples, depois o modelo classifica com esquema JSON → o BIOMIE executa a
     consulta permitida daquela intenção, com as permissões do usuário → o modelo redige. Fora do catálogo: resposta
     padrão dizendo o que dá para perguntar. **Nunca SQL gerado pelo modelo, nunca escrita no Omie.**
   - `alertas`: regras do BIOMIE (ritmo abaixo do necessário para a meta, queda contra a média de 3 meses, cliente
     recorrente sem compra há 60 dias, concentração em poucos clientes, estoque parado) → o modelo só escreve as
     sugestões. Lote diário depois da análise das 06:33, com chave própria de prioridade "lote".
3. **Trava de números:** todo número da resposta tem de existir nos fatos (com tolerância de formatação). Se não,
   a resposta é descartada e entra um texto-modelo com os mesmos fatos.
4. **Perfis:** chave `ai_assistant` no `metric_config` (desligada por padrão; perfis liberados: começa só
   SUPER_ADMIN). Vendedor só vê fatos dos próprios números porque a consulta usa a sessão dele.
5. **Registro:** tabela `private.ai_requests` (migração 0052) só com metadados (usuário, empresa, intenção, status,
   tempos, tokens, avaliação útil/não útil); retenção de 90 dias.
6. **Indisponibilidade:** a tela continua com os números; o bloco da IA mostra "explicação automática indisponível
   agora". 503 "ocupado" vira "tente em instantes".
7. **Infra do BIOMIE:** o web entra na rede `mag-ai_biomie` (compose da release); o `21_activate_release` cria a rede
   vazia se ela não existir, para o BIOMIE nunca deixar de subir por causa da IA.
8. **Testes:** unidade (trava de números, roteador de intenções, montagem dos fatos), integração com gateway de
   mentira, suítes SQL de permissão (vendedor), navegador com a chave ligada e desligada, IA fora do ar.
9. **Liberação:** desligada → SUPER_ADMIN (piloto) → ADMIN/GESTOR → VENDEDOR, cada etapa com aprovação.

## 7. Expansão para outros sistemas

Nova aplicação = gerar chave (`node src/chave.mjs <app>`), acrescentar política no `apps.json`, criar a rede
`mag-ai_<app>` (interna), ligar o gateway e o container da aplicação a ela e reiniciar só o gateway. Nenhum Ollama
novo. Sistemas PHP no próprio servidor (sem Docker) precisarão de uma porta do gateway em 127.0.0.1, a decidir quando
chegar a vez deles; o cliente PHP (cURL com prazo, mesmos códigos de erro) entra nesse momento.

## 8. Monitoramento

`/etc/cron.d/mag-ai-saude` a cada 5 min → `/var/log/mag-ai-saude.csv` (memória atual e pico do Ollama lidos do
cgroup, CPU, modelo carregado, pedidos, erros, ocupado, p95, fila, reinícios, memória livre e carga do servidor) e
avisos em `/var/log/mag-ai-saude.log`: Ollama acima de 90% do teto, queda por memória, reinício, 3+ erros em 5 min,
p95 acima de 60 s, disjuntor aberto, servidor com menos de 1,5 GB livres.

## 9. Fase 3 — roteiro (só com aprovação explícita)

| passo | o que faz | muda no servidor | tempo |
|---|---|---|---|
| `verificar` | pré-requisitos, janela, foto "antes" de tudo que não é do MAG AI | nada | 1 min |
| `preparar` | pastas, chaves, `.env`, volume e rede `mag-ai_biomie` (vazia) | só itens novos do mag-ai | 1 min |
| `construir` | imagens do Ollama (pacote oficial conferido) e do gateway | 2 imagens novas | 5–8 min |
| `modelo` | download por rede temporária, conferência das camadas | volume do mag-ai | 2–4 min |
| `subir` | 2 containers, saúde, monitor e backup (04:12) | 2 containers, 2 crons, 1 logrotate | 1 min |
| `testar` | portas, sem internet, chaves, API do Ollama fechada, função, desempenho, fila, limite | nada | ~5 min |
| `comparar` | foto "depois" × "antes": nada fora do MAG AI pode ter mudado | nada | 1 min |

Portões: só fora do expediente, carga < 1,0, ≥ 3 GB livres, sem homologação de outro sistema rodando. Qualquer
falha para o roteiro. O BIOMIE não é tocado na Fase 3 (o teste usa um container descartável na rede dele).

## 10. Reversão

1. **IA no BIOMIE** (Fase 4 em diante): desligar a chave `ai_assistant` — sem deploy.
2. **MAG AI parado:** `mag-ai.sh desfazer` → derruba os 2 containers e tira monitor e backup (~1 min). Volume, rede e
   imagens ficam para voltar com `subir`. Conferência: `mag-ai.sh comparar antes depois-desfazer`.
3. **Remoção total:** `mag-ai.sh remover --confirmo` → apaga volume, redes, imagens e pastas; guarda documentos e
   chaves em `/root/backups`. Não apaga a rede `mag-ai_biomie` se o BIOMIE ainda estiver ligado a ela.
4. **BIOMIE:** release anterior pelo procedimento de sempre (`21_activate_release.py <anterior>`) + `0052.down`.

## 11. Fase 5 — homologação

Apresentar: memória (parado, carregado, pico), CPU por pedido, tempos (primeira palavra e total; p50/p95), tokens por
segundo, comportamento da fila, impacto nos outros sistemas (carga do servidor e tempos do BIOMIE antes × depois),
qualidade (30 perguntas com dados fictícios e da cópia de homologação: % de respostas com todos os números certos,
% de intenções certas, % de recusas corretas fora do catálogo), limitações e o teste de reversão. Comparar
`0.8b-q8_0` × `0.8b` (com o auxiliar) × ajustes de memória (`OLLAMA_FLASH_ATTENTION`, cache de contexto em q8_0)
e escolher pelos números.

## 12. Riscos e limitações

- **Velocidade:** estimativa de 10–30 s por explicação em 1 vCPU (a medir na Fase 3). Respostas em streaming e
  resumos diários pré-calculados escondem boa parte da espera.
- **Uma pessoa por vez:** com vários usuários juntos, a fila responde "ocupado". Resumos pré-calculados reduzem a
  procura ao vivo.
- **Qualidade de um modelo de 0,8B:** frases simples e corretas a partir de fatos prontos; fraco para deduzir. Se não
  bastar: `qwen3.5:2b-q4_K_M` (1,9 GB, ~2–3× mais lento, precisa de teto maior) ou aumentar a VPS.
- **Memória no pior caso:** se a IA chegar ao teto no pior momento já visto, sobra ~1 GB no servidor. O teto sem swap
  e a prioridade de queda fazem a IA cair antes dos outros.
- **Versões do Ollama saem quase todo dia:** atualização só por homologação, com nova versão fixada.
