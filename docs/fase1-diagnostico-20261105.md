# MAG AI — Fase 1: diagnóstico da VPS (05/11/2026)

Somente leitura, em 05/11/2026 às 14:38 (horário de Brasília). Nada foi instalado, reiniciado ou alterado.
Coleta: `fase1_diagnostico.sh` (estado atual) e `fase1_historico.sh` (17 dias de histórico do monitor do BIOMIE v2
e do sysstat). Nenhum arquivo `.env` ou variável de ambiente de container foi lido.

## Capacidade real

| item | valor |
|---|---|
| servidor | srv1851839, Hostinger KVM 2, Ubuntu 24.04.4 LTS, kernel 6.8.0-147, ligado há 12 dias (desde 23/10 16:14) |
| CPU | 2 vCPUs AMD EPYC 9354P (Zen 4) com AVX2 e AVX-512 (inclui VNNI e BF16): bom para IA em CPU. Sem GPU |
| memória | 7,75 GiB no total; às 14:38: 3,5 GB em uso, **4,4 GB disponíveis** |
| swap | arquivo de 2 GB, **1,2 GB ocupados** por processos parados há tempo (MariaDB, gunicorn, n8n); pressão de memória ≈ 0 |
| disco | 96 GB, 60 GB usados, **36 GB livres** (63%); imagens Docker 35,8 GB; limpeza diária de imagens às 05:01 |
| CPU roubada pelo hipervisor | 1–7% agora; média por hora 3–8% |
| Docker | 29.7.2, Compose v5.4.0, cgroup v2 (limites de memória e CPU funcionam), logs 10 MB × 3 |
| containers | 57 (28 rodando, 29 parados: sobras da homologação do VSB 360) |
| portas abertas para fora | só 22, 80 e 443; todo o resto escuta em 127.0.0.1. Firewall (UFW) ativo, entrada negada por padrão |
| Ollama | não instalado; porta 11434 livre |
| quedas por falta de memória | nenhuma em 30 dias |

## Histórico de 17 dias (19/10 a 05/11; 4.862 amostras a cada 5 min)

| medida | valor |
|---|---|
| memória disponível — mínima | **3.590 MB** (03/11 22:10, teste de restauração do arquivo do BIOMIE antigo) |
| memória disponível — média | 4.346 MB; nunca abaixo de 3,5 GB |
| swap usada — máxima | 1.377 MB |
| carga (média de 5 min) | típica 0,4–0,65; máxima 3,26 (23/10, dia dos reinícios) |
| CPU ocupada (média de 10 min, das 2 vCPUs) | 13–20% em média em todas as horas; pico 47,5% |

Não há hora do dia sem folga: a memória disponível média fica entre 4,3 e 4,4 GB das 0h às 23h.

## Quem roda na VPS

| sistema | como | limite de memória |
|---|---|---|
| BIOMIE v2 (produção) | Docker: Postgres 17, PostgREST, GoTrue, nginx, web e worker | web 1,5 GB, worker 512 MB, banco 768 MB |
| BIOMIE antigo (PHP) | php8.3-fpm + MariaDB + biomie-python (em desativação; passo 2 na noite de 06/11) | sem |
| ERP VSB (ERPNext) | Docker, 9 containers | **sem limite** (observação) |
| n8n da VSB | Docker, 3 containers | 1 GB + 512 MB + 512 MB |
| CMS VSB (WordPress) | Docker, 2 containers | 2 GB + 1 GB |
| site MAG | Docker, 3 containers | 768 MB + 2 × 128 MB |
| SCF (RH) | Docker, 2 containers | 2 × 384 MB |
| site VSB, landing VSB, Criativo em Tela, base de tarefas | Docker / PHP-FPM / MariaDB do servidor | variado |
| builder da homologação do BIOMIE | Docker (buildx) | 3 GB |

Backups: todos os projetos rodaram hoje entre 02:10 e 03:53 (`vps-backup-run`, cópia externa com conferência de hash).

## Como o BIOMIE está hospedado

- O BIOMIE em produção é o **v2**: TanStack Start (React com funções de servidor), Supabase (Postgres 17 + PostgREST +
  GoTrue) e worker, no projeto Docker `biomie-v2`, rede `biomie-v2_default`, web em 127.0.0.1:3130 atrás do nginx.
- As telas leem os números por **funções de servidor** que usam a sessão do próprio usuário: as permissões do
  banco (RLS) valem automaticamente. É ali que a IA deve entrar.
- O repositório `bvladson/biomie` no GitHub guarda o **BIOMIE antigo em PHP**, que está sendo desligado (o usuário
  decidiu em 21/10 manter só o novo). Integrar a IA nele seria trabalho perdido.

## Conclusão

Cabe, com limites rígidos:

- **Memória:** o modelo pequeno deve ocupar 1,2–1,6 GB carregado. Com teto de 2,5 GB, no pior momento já visto
  sobraria ~1 GB no servidor se a IA chegasse ao teto; no esperado, ~2 GB. O modelo sai da memória após 15 min sem uso.
- **CPU:** 1 das 2 vCPUs, com prioridade menor que a dos outros sistemas, uma geração por vez.
- **Disco:** +1,5 GB (imagem só com CPU ~0,3 GB + modelo 1,0 GB).
- **Rede:** nenhuma porta nova; tudo em redes internas do Docker.

Pontos de atenção: swap já com 1,2 GB ocupados (inativos), CPU compartilhada com outros clientes da Hostinger (3–8%)
e ERPNext sem limite de memória.
