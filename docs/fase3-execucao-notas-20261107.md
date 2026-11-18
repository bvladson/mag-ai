# MAG AI, Fase 3: notas da execução (madrugada de sábado 07/11/2026)

Números brutos para o relatório técnico. Horários de Brasília. Medidas feitas somente com leitura de
`/proc/loadavg`, `/proc/meminfo` e `/proc/net/dev` (interface da rota padrão: `eth0`). Cópia no servidor em
`/srv/mag-ai/docs/medidas-downloads-20261107.txt`.

## Etapa 1 (00:31–00:34): portão e passos leves

- `checklist`: 0 falhas, 0 avisos. Memória disponível 4.670 MB, carga 0,43, disco 29 GB livres. BIOMIE v2 na
  release f4bbe45540f9, web e worker no ar há 26 h, monitor sem aviso em 12 h, homologação do BIOMIE parada,
  legado inativo (biomie-python inactive, 0 tarefas).
- Pacote `pacote-mag-ai-20261107c.tar.gz` enviado para `/opt/mag-ai/build/`; sha256 13b55b9e… conferido no
  servidor; 38 arquivos extraídos, sem CR.
- `verificar` 00:33:08–00:33:13: foto "antes" com 223 linhas. A carga encostou em 1,04 durante a coleta (aviso,
  não falha).
- `preparar` 00:33:36: gateway 0.1.0-b8a3326223, volume `mag-ai_modelos`, rede `mag-ai_biomie` interna, vazia e
  sem endereço do servidor na ponte (o Docker aceitou `inhibit_ipv4`). Chaves geradas (texto só em
  `/srv/mag-ai/CREDENCIAIS.txt`, 600; `apps.json` root:10080 640).
- Na foto "antes" está a homologação do MAG CRM (`mag-crm-waha-hml-20261106-web-1`, outro projeto, no ar desde
  06/11 à tarde). Se ela mudar antes do `comparar`, a diferença é da outra sessão.

## Etapa 2 (01:01–01:07): imagens, modelo e subida

Construtor do Docker: `default` (driver docker); o construtor da homologação do BIOMIE não foi usado.

| passo | início → fim | duração | recebido (eth0) | carga 1/5/15 min antes → depois | MemAvailable antes → depois |
|---|---|---|---|---|---|
| construir | 01:02:28 → 01:03:51 | 83 s | 1.630.024.752 bytes (1,63 GB) | 0,60 0,59 0,50 → 1,67 0,92 0,63 | 4.542 → 4.540 MB |
| (intervalo) | 01:03:51 → 01:04:58 | 67 s | 17.233 bytes | 1,67 → 0,83 | |
| modelo | 01:04:58 → 01:05:18 | 20 s | 1.070.362.551 bytes (1,07 GB) | 0,83 0,85 0,62 → 1,67 1,04 0,69 | 4.612 → 4.617 MB |
| subir | 01:06:28 → 01:06:35 | 7 s | 2.330 bytes | 0,56 0,83 0,64 → 0,79 0,87 0,66 | 4.619 → 4.580 MB |

- Total baixado pelo MAG AI: ~2,70 GB em ~103 s de transferência, uma única vez. O contador é da interface inteira
  (inclui qualquer outro tráfego do servidor nesses intervalos e os cabeçalhos de rede, ~4%).
- O pacote oficial do Ollama 0.40.14 bateu com o hash fixado (`pacote.tar.zst: OK` aos 44,9 s do passo) e com o
  `sha256sum.txt` da release; a imagem respondeu com a versão 0.40.14.
- Imagens: `mag-ai-ollama:0.40.14-cpu` 235 MB e `mag-ai-gateway:0.1.0-b8a3326223` 330 MB (tamanho informado pelo
  `docker images`).
- Modelo no volume: 973 MB.
- Manifesto: o arquivo local do Ollama tem hash 420789f1… em vez do fixado 7c00f78a…. Motivo: o Ollama 0.40.14
  guarda o manifesto original do registro como um arquivo à parte e acrescenta uma referência a ele no manifesto
  local. Configuração e as 5 camadas são idênticas às fixadas (mesmos hashes, tamanhos e ordem). Os 7 arquivos do
  volume foram recalculados um a um e conferem com o próprio nome, inclusive o manifesto original
  (`sha256-7c00f78a…`, igual ao fixado) e os dois pesos (`889ea3b9…` e `5ba2eb9b…`).
- `subir`: os dois containers ficaram saudáveis em ~6 s; o log do Ollama confirma nuvem desligada; as pontes de
  `mag-ai_interna` e `mag-ai_biomie` estão sem endereço do servidor; nenhuma porta publicada. Instalados
  `/etc/cron.d/mag-ai-saude` (a cada 5 min), `/etc/cron.d/mag-ai-backup` (04:12) e `/etc/logrotate.d/mag-ai`.
- Limites conferidos com `docker inspect`: Ollama 2.560 MiB sem swap, 1 CPU, cpu_shares 512, oom_score_adj 500,
  pids 256, raiz só leitura, cap_drop ALL, no-new-privileges, usuário 10434, só em `mag-ai_interna`. Gateway
  192 MiB sem swap, 0,25 CPU, pids 64, raiz só leitura, cap_drop ALL, no-new-privileges, usuário 10080, em
  `mag-ai_biomie` e `mag-ai_interna`.
- Em repouso às 01:06:55: Ollama 11,3 MiB, gateway 17,4 MiB (o modelo só carrega no primeiro pedido).
- As leituras do fechamento de estoque das 23:50 podem ter coincidido com os downloads; isso não é verificável sem
  consultar o banco do BIOMIE, o que esta sessão não faz.
