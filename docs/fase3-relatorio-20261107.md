# MAG AI, Fase 3: relatório técnico da implantação

Sábado 07/11/2026, madrugada (horários de Brasília). Escopo aprovado em 05/11: implantação isolada do Ollama e do
gateway MAG AI, com os testes previstos e o ensaio de reversão. Nada da Fase 4 foi feito.

## Resultado

- **Instalado e testado.** Ollama 0.40.14 (imagem só com CPU) e gateway MAG AI 0.1.0-b8a3326223, com o modelo
  `qwen3.5:0.8b-q8_0`. Os dois contêineres estão no ar, saudáveis e ociosos, sem porta no servidor.
- **Todos os passos passaram.** Os testes deram 19 OK e 0 FALHA. O ensaio de reversão passou. As duas
  comparações antes × depois deram zero diferenças fora do MAG AI. O checklist final deu 0 falhas e 0 avisos.
- **Nenhum critério de parada foi atingido.** O pico do Ollama foi de 1.783 MB (parada em 2.400). A memória livre
  mínima do servidor foi de 3.021 MB (parada em 1.500). Não houve encerramento por memória nem sonda alcançando
  algo bloqueado.
- **A qualidade das respostas é limitada.** O modelo copia bem os números dos fatos, mas erra interpretação: disse
  que a meta foi batida com 91,6% e inventou uma margem de lucro. Na classificação de intenção, acertou 3 de 6.
  Isso não reprova a instalação, mas muda o desenho da Fase 4 (ver recomendações).
- **O BIOMIE v2 não foi tocado.** Release f4bbe45540f9, web e worker sem reinício (no ar há 28 h no fim) e nenhum
  aviso do monitor na janela.

## Linha do tempo

| hora | passo | resultado |
|---|---|---|
| 00:31 | `checklist` (portão, só leitura) | 0 falhas, 0 avisos; 4.670 MB livres; carga 0,43 |
| 00:32 | envio do pacote | sha256 13b55b9e… conferido no servidor; 38 arquivos, sem CR |
| 00:33 | `verificar` e `preparar` | foto "antes" (223 linhas); chaves, volume e rede `mag-ai_biomie` interna, sem endereço do servidor |
| 01:02:28–01:03:51 | `construir` | 83 s; pacote oficial conferido por SHA256; imagem respondeu 0.40.14 |
| 01:04:58–01:05:18 | `modelo` | 20 s; camadas fixadas conferidas; rede temporária removida |
| 01:06:28–01:06:35 | `subir` | saudáveis em ~6 s; nuvem do Ollama desligada; monitor e backup instalados |
| 01:31:33–01:35:33 | `testar` | 4 min; 19 OK, 0 FALHA |
| 01:38:07 | descarga do modelo | Ollama voltou a 14 MB, 2 min e meio após o último pedido |
| 01:38:26–01:38:38 | `ensaiar-reversao` | desfazer em menos de 1 s; nada fora do MAG AI mudou; reinstalado e saudável em 6 s |
| 01:38:54 | `comparar antes depois` | nada fora do MAG AI mudou |
| 01:38:59 | `checklist` final | 0 falhas, 0 avisos |
| 01:40:28 | sonda complementar | fecha a lacuna das sondas (ver Segurança) |

O servidor ficou livre às 01:41, antes dos backups das 02:10. As reservas das 04:31 e 05:31 não foram usadas.

## Uso real de recursos

### CPU

| medida | valor |
|---|---|
| CPU do Ollama nos testes | 216 s em ~234 s de teste (≈ 92% do teto de 1 CPU) |
| teto de CPU atuando | 563 limitações do cgroup, 0,87 s no total |
| carga de 1 min do servidor antes dos testes | 0,27–0,30 |
| carga de 1 min durante os testes | média 1,64; máxima 2,63 (01:32:36) |
| carga de 1 min depois (01:38) | 0,27–0,31 |
| carga no `construir` e no `modelo` | subiu até 1,67 (descompactação), por cerca de 1 min cada |

O Ollama fica preso a 1 das 2 vCPUs e cede em disputa (cpu_shares 512), então sempre sobra 1 vCPU para os outros
sistemas. A carga acima de 2 mostra fila de processos durante a geração, sem efeito visível nos outros serviços: o
monitor do BIOMIE não deu aviso e nenhum contêiner reiniciou.

### Memória

| medida | valor |
|---|---|
| Ollama sem modelo carregado | 8–20 MB |
| Ollama com modelo carregado | 1.655–1.776 MB |
| Ollama no pico | 1.783 MB (70% do teto de 2.560 MB; parada em 2.400) |
| encerramentos por falta de memória | 0 |
| gateway | 17–39 MB (teto de 192 MB) |
| memória livre do servidor no início do teste | 4.636 MB |
| memória livre mínima durante o teste | 3.021 MB (01:35:23) |
| memória livre com o modelo carregado e parado | 2.986 MB (01:36:37) |
| memória livre depois da descarga (2 min sem uso) | 4.773 MB (01:38:07) |
| swap em uso no servidor | 1.417 MB (00:31) → 1.514 MB (01:38): +97 MB |
| pressão de memória (média de 5 min) | 0,00% antes → 0,86% às 01:38 |

O modelo carregado ocupa cerca de 1,7 GB e sai da memória sozinho 2 minutos depois do último pedido. No pico, o
servidor moveu cerca de 100 MB de páginas inativas de outros serviços para o swap. Não houve falta de memória.

### Disco e rede

| item | tamanho |
|---|---|
| imagem `mag-ai-ollama:0.40.14-cpu` | 235 MB |
| imagem `mag-ai-gateway:0.1.0-b8a3326223` | 330 MB |
| volume `mag-ai_modelos` (modelo) | 973 MB |
| `/opt/mag-ai` e `/srv/mag-ai` | 488 KB e 140 KB |
| imagem `node` usada só pelos contêineres de teste | 333 MB (sai na limpeza das 05:01 e volta quando precisar) |
| disco livre do servidor | 29 GB → 28 GB |

| download | horário | volume recebido | duração |
|---|---|---|---|
| `construir` (pacote do Ollama, imagens base, apt) | 01:02:28–01:03:51 | 1.630.024.752 bytes (1,63 GB) | 83 s |
| `modelo` | 01:04:58–01:05:18 | 1.070.362.551 bytes (1,07 GB) | 20 s |
| imagem `node` para os testes | 01:31:34 | não medido | segundos |

Os volumes vêm do contador da interface `eth0` do servidor, que inclui qualquer outro tráfego no mesmo intervalo e
os cabeçalhos de rede (~4%).

## Tempos de resposta

| pedido | tempo |
|---|---|
| primeiro pedido, com carga do modelo (explicar, até 220 tokens) | 44,4 s |
| explicar com modelo carregado (5 rodadas, até 200 tokens) | 12,7 / 14,2 / 11,9 / 11,1 / 8,9 s |
| leitura do pedido (314–328 tokens) | 4,5–4,8 s (68–70 tokens/s) |
| geração (83–123 tokens) | 13,1–13,6 tokens/s (9,5 na 5ª rodada) |
| leitura com começo de texto repetido (5ª rodada) | 0,14 s |
| resumo em streaming | primeira palavra em 4,6 s; total 10,9 s |
| classificar (resposta em JSON) | 2,2–4,1 s |
| responder (perguntas da bateria) | 4,5–15,1 s |
| fila: 6 pedidos ao mesmo tempo | 3 atendidos (esperas de 0, 6,6 e 15,2 s); 3 recusados na hora com "ocupado" (503); total 24,1 s |
| limite da aplicação biomie: 7 pedidos ao mesmo tempo | 200, 200, 503, 200, 503, 503, 429: o 7º recebe "limite" |

Com o modelo carregado, uma explicação curta leva de 9 a 14 s. Depois de 2 minutos sem uso, o primeiro pedido leva
cerca de 45 s, porque o modelo precisa ser carregado de novo.

## Qualidade das respostas

Bateria com dados fictícios de outubro: faturamento R$ 412.350,00, meta R$ 450.000,00 (91,6% atingido), setembro
R$ 389.120,00 (+6,0%), 37 pedidos, ticket médio R$ 11.144,59, maior vendedora Ana com R$ 158.900,00 (38,5%), 5
clientes novos.

| pergunta | resposta (resumida) | avaliação automática | avaliação humana |
|---|---|---|---|
| Quanto faturamos em outubro? | R$ 412.350,00, repetido, mais dados não pedidos | certa | certa, prolixa |
| Batemos a meta de outubro? | "Sim, atingiu a meta de 91,6%" | certa | **errada**: 91,6% da meta = não bateu |
| Como outubro se compara com setembro? | diferença de 23.230,00; "ticket aumentou de 11.144,59 para 11.144,59" | errada | **errada**: a diferença está certa, mas não estava nos fatos; o resto não faz sentido |
| Quem vendeu mais em outubro? | "Ana vendeu mais que todos os outros clientes" | certa | certa (chamou vendedores de clientes) |
| Qual foi o ticket médio de outubro? | R$ 11.144,59, mais dados não pedidos | certa | certa |
| Quantos clientes novos tivemos? | "5." | certa | certa |
| Faturamento de dezembro de 2025? (fora dos fatos) | "Não há dados suficientes." | certa | certa |
| Margem de lucro de outubro? (fora dos fatos) | "10,2%" | errada | **errada**: número inventado |

- **Respostas:** 6 de 8 certas na avaliação automática, 5 de 8 na leitura humana.
- **Explicação livre** (explicar): usou só números dos fatos, mas concluiu que "a empresa atingiu o objetivo de
  faturamento de R$ 450.000,00 com sucesso", o que é falso. Também atribuiu ao ticket médio o aumento de 6,0%, que
  era do faturamento.
- **Classificação de intenção:** 3 de 6. O JSON veio sempre válido dentro do esquema, mas "melhores vendedores"
  virou comparação de períodos e "previsão do tempo" virou faturamento, em vez de fora do escopo.
- **Pontos fortes:** copia os números dos fatos exatamente como estão, responde em português, recusou uma pergunta
  fora dos fatos e respeita o formato JSON.
- **Pontos fracos:** interpreta mal percentual de meta, inventa número quando não sabe, faz comparações sem sentido
  e classifica mal.

Conclusão: o modelo 0.8B serve para reescrever em texto fatos que o BIOMIE já calculou. Não serve para tirar
conclusões sozinho nem para escolher a intenção do usuário.

## Segurança

| verificação | resultado |
|---|---|
| sem chave / chave inventada | 401 nos dois casos |
| API do Ollama pelo gateway (`/api/tags`, `pull`, `generate`, `ps`, `delete`) | 404 nos 5 |
| Ollama direto a partir da rede do BIOMIE | inacessível |
| internet a partir da rede do BIOMIE e da rede do Ollama | sem saída (registro do Ollama inalcançável nas duas) |
| imagem no pedido | recusada (400) |
| pedido grande demais | recusado (413) |
| fila e limite por minuto | funcionando (503 "ocupado" e 429 "limite", sem erro) |
| portas no servidor | nenhuma (`docker port` vazio; só 22, 80 e 443 abertas para fora, como antes) |
| credenciais nos contêineres | nenhuma; o gateway guarda só o hash das chaves |
| montagens | Ollama: só o volume do modelo; gateway: `apps.json` só leitura |
| endurecimento | raiz só leitura, cap_drop ALL, no-new-privileges, usuários sem privilégio (10434 e 10080), limite de processos |
| pontes das redes do MAG AI | sem endereço do servidor (conferido com `ip addr` nas duas) |
| nuvem do Ollama | desligada (confirmado no log) |
| nomes dos bancos e serviços de outros projetos | não resolvem nas redes do MAG AI (8 na interna, 9 na do BIOMIE) |
| IP público do servidor (21 portas) e IPs dos 7 bancos | sem rota (ENETUNREACH) |

**Lacuna encontrada e fechada.** Com a ponte sem endereço, o Docker informa o gateway da rede como `invalid IP`.
O script quebrou esse texto em "invalid" e "IP", e 84 dos 113–114 bloqueios de cada sonda testaram nomes
inexistentes, sem provar nada. Às 01:40 rodei a mesma sonda, nas mesmas condições, contra os endereços .1 das duas
sub-redes e o docker0 (172.17.0.1):

- o .1 de cada rede é um contêiner do próprio MAG AI: o Docker o entregou a um contêiner porque não há gateway
  reservado. Na interna, 172.16.14.1 = Ollama, só a porta 11434 aberta. Na do BIOMIE, 172.16.13.1 = gateway, só a
  8080 aberta. As outras 20 portas foram recusadas pelos próprios contêineres;
- a outra sub-rede e o docker0 deram sem rota: 42 de 42 nas duas redes.

O servidor não é alcançável pelas redes do MAG AI. O cálculo do gateway na sonda precisa ser corrigido no próximo
pacote. O código desta instalação não foi alterado.

## Impacto na VPS

- **Foto antes × depois:** 223 linhas iguais nas duas comparações (`antes` às 00:33, `depois-desfazer` às 01:38:31
  e `depois` às 01:38:54). A foto cobre os contêineres de fora com hora de início, imagem e reinícios, as portas
  em escuta, o firewall, a cadeia DOCKER-USER, o hash de cada arquivo do nginx, o daemon do Docker, o cron e as
  redes e volumes de fora. Nenhum contêiner de outro projeto reiniciou.
- **BIOMIE v2:** release f4bbe45540f9 do começo ao fim; web e worker no ar há 26 h às 00:31 e 28 h às 01:38;
  monitor sem aviso entre 00:30 e 01:40.
- **Memória e carga:** ver acima. Pior momento: 3.021 MB livres e carga 2,63 durante a geração. Tudo voltou ao
  normal 2 minutos depois do último pedido.
- **Downloads:** 1,63 GB às 01:02–01:03 e 1,07 GB às 01:05, uma única vez. As leituras do fechamento de estoque das
  23:50 podem ter coincidido com esses horários. Isso não é verificável sem consultar o banco do BIOMIE, o que esta
  sessão não faz.
- **Outros sistemas:** ERPNext, nginx, firewall, daemon do Docker e bancos inalterados (foto). A homologação do MAG
  CRM, de outro projeto, seguiu igual.
- **Construtor do Docker:** a montagem usou o construtor padrão do servidor, não o construtor da homologação do
  BIOMIE.

## Ensaio de reversão

| etapa | resultado |
|---|---|
| desfazer (derruba os 2 contêineres e tira o monitor e o backup) | menos de 1 s |
| comparação antes × depois-desfazer | nada fora do MAG AI mudou |
| subir de novo | saudável em 6 s |
| ensaio completo | 12 s (01:38:26–01:38:38) |

Para voltar de verdade: `/opt/mag-ai/bin/mag-ai.sh desfazer` e conferir com
`/opt/mag-ai/bin/mag-ai.sh comparar antes depois-desfazer`. Volume, rede e imagens ficam para voltar rápido com
`subir`. Remoção total: `mag-ai.sh remover --confirmo` (guarda documentos e chaves em `/root/backups`).

## Pontos de atenção

1. **Hash do manifesto.** O manifesto que o Ollama 0.40.14 grava tem hash 420789f1…, e não o fixado 7c00f78a….
   O Ollama guarda o manifesto original do registro como arquivo à parte e acrescenta uma referência a ele. A
   configuração e as 5 camadas são idênticas às fixadas. Os 7 arquivos do volume foram recalculados um a um e
   conferem, inclusive o manifesto original (= fixado) e os dois pesos.
2. **Sonda com "invalid IP".** Descrito em Segurança; fechado com a sonda complementar. Corrigir no próximo
   pacote: tirar o .1 da sub-rede e listar os IPs dos próprios contêineres.
3. **Primeiro pedido lento.** Depois de 2 minutos sem uso, o primeiro pedido leva ~45 s. Na Fase 4, a tela precisa
   avisar "preparando a IA". Também dá para avaliar uma descarga mais longa no horário comercial (mais memória
   ocupada por mais tempo).
4. **Swap.** No pico, ~100 MB de páginas inativas de outros serviços foram para o swap. Não houve falta de memória.
5. **Cópia externa do backup sem cifra.** O backup diário do MAG AI (04:12, primeiro hoje) vai para a cópia externa
   por scp, sem cifra, como os outros 8 projetos. Como o pacote leva as chaves das aplicações, conferir o primeiro
   resultado em `/var/log/vps-backup-mag-ai.log`. Recomendo cifrar o pacote ou tirar as chaves dele num ajuste
   futuro. Risco baixo: as chaves só funcionam dentro da rede interna do servidor.
6. **Imagem de teste.** A imagem `node` dos testes sai na limpeza das 05:01 e é baixada de novo quando os testes
   rodarem outra vez. As imagens do MAG AI ficam protegidas porque os contêineres estão de pé.

## Recomendações para a Fase 4 (não executadas; dependem da aprovação deste relatório)

- O BIOMIE calcula todos os indicadores e também as conclusões: meta batida sim/não, diferença em reais, variação,
  quanto faltou. A IA só reescreve esses fatos em texto.
- Conferir os números de toda resposta contra os fatos (o teste já tem esse detector). Resposta com número que não
  está nos fatos não vai para a tela, ou vai marcada.
- Não usar o modelo para escolher a intenção do usuário: no teste, ele acertou 3 de 6. Usar menus ou regras fixas.
- Mostrar o texto da IA como "assistente", com os fatos visíveis ao lado.
- Se a qualidade não bastar, testar `qwen3.5:2b-q4_K_M` (1,9 GB, 2 a 3 vezes mais lento, precisa de teto maior).
  Isso muda D2 e D4 e exige nova aprovação.

## Evidências

No servidor:

- `/srv/mag-ai/docs/teste-20261107-013133.txt` (OK/FALHA, QUALIDADE e RESUMO);
- `/srv/mag-ai/docs/teste-20261107-013133-recursos.csv` (amostras a cada ~2 s);
- `/srv/mag-ai/docs/sonda-{interna,biomie}-20261107-013133.txt` e `sonda-extra-{interna,biomie}-20261107-014028.txt`;
- `/srv/mag-ai/docs/medidas-downloads-20261107.txt`;
- `/srv/mag-ai/fotos/` (fotos e diferenças: os dois arquivos de diferenças estão vazios);
- `/var/log/mag-ai-implantacao.log`;
- `/var/log/mag-ai-saude.csv` (monitor a cada 5 min).

Cópia local, sem as fotos detalhadas e sem chaves: `C:\Users\VLADSON\Downloads\mag-ai\docs\evidencias-20261107\`.
Notas da execução: `docs/fase3-execucao-notas-20261107.md`.
