# MAG AI — Fase 3: checklist final e roteiro da madrugada de sábado 07/11/2026

Situação: **APROVADA pelo usuário em 05/11/2026 às 16:22** (D1 a D5; somente a implantação isolada do Ollama e do
gateway, com testes e ensaio de reversão; integração com o BIOMIE só na Fase 4). Janela trocada pelo usuário em
05/11 para a **madrugada de sexta para sábado, 07/11, das 00:30 às 02:00**, com reservas às 04:31 e 05:31 (antes:
domingo 08/11, depois sábado à tarde), para o projeto amanhecer instalado e testado. Nada instalado até agora.

Pacote a implantar: `dist/pacote-mag-ai-20261107c.tar.gz` (hash conferido no servidor antes de extrair; hash de cada
arquivo em `dist/pacote-mag-ai-20261107c.sha256.txt`). O teste de ponta a ponta inclui uma bateria de qualidade (8 perguntas com resposta conhecida
ou fora dos fatos e 6 classificações de intenção), que mede e não reprova.

O checklist abaixo foi gerado na VPS em 05/11 às 15:49 pelo comando `mag-ai.sh checklist` (somente leitura;
conferido depois que nada foi gravado). Ele é repetido na sexta às 22:07 (pré-checagem) e no sábado às 00:31
(portão): qualquer FALHA cancela a instalação.

## Decisões após o parecer

| # | status |
|---|---|
| D1 | aprovada: integração no BIOMIE v2 (Fase 4) |
| D2 | aprovada: `qwen3.5:0.8b-q8_0` |
| D3 | aprovada e validada (`d3-validacao-dockerfile.md`): hashes, conteúdo, dependências e permissões conferidos |
| D4 | aprovada: 2,5 GB sem swap, 1 vCPU, **contexto 2.048**, **fila de 2** (1 em execução + 2 esperando; o 4º recebe "ocupado"), **descarrega após 2 min** |
| D5 | aprovada; janela trocada pelo usuário para a **madrugada de sábado 07/11, 00:30–02:00** (reservas às 04:31 e 05:31), com o BIOMIE v2 estável e sem coincidir com o passo 2 do legado |

Consequência da D4: com contexto de 2.048, cada pedido aceita até ~4.500 caracteres de entrada.
Os fatos que o BIOMIE mandar na Fase 4 precisam caber nisso.

## Checklist (05/11 15:49) — 0 falhas, 0 avisos

**1. Memória, CPU e disco**
- memória disponível: 4.414 MB (mínimo para começar: 3.000); menor das últimas 24 h: 3.815 MB;
- pressão de memória 0%; carga 0,46; disco livre 36 GB (o MAG AI usa ~1,5 GB);
- swap em uso 1.249 MB (páginas inativas de outros serviços; informativo).

**2. Isolamento de redes**
- firewall ativo, entrada só em 22 e 80/443; cadeia DOCKER-USER vazia; portas abertas para fora: 22, 80, 443;
- redes do MAG AI ainda não existem; serão internas (sem internet) e **sem endereço do servidor na ponte**;
- rede temporária do download não existe; 11 de 4.096 faixas Docker em uso.

Achado e correção: por padrão, uma rede interna do Docker continua com um endereço do próprio servidor
(confirmado em `vsb360-hml_internal`: 172.16.5.1), pelo qual um container alcançaria as portas que o servidor já
abre para a internet (22, 80, 443). O nginx não tem regra que dê acesso especial a endereços internos, e o SSH só
aceita chave (senha desligada, fail2ban ativo). Mesmo assim, as redes do MAG AI serão criadas com a opção do Docker
`com.docker.network.bridge.inhibit_ipv4`, que deixa a ponte sem endereço do servidor: o container só fala com
container. É uma propriedade da rede nova; firewall e nginx não mudam. As sondas do passo `testar` provam o efeito;
se a opção não funcionar nesta versão do Docker, a instalação para e eu trago a decisão.

**3. Acesso aos bancos**
- MariaDB do servidor só em 127.0.0.1:3306 e 3307 (container nenhum alcança 127.0.0.1 do servidor);
- nada escuta em 5432, 6379 ou 27017 no servidor;
- os 7 containers de banco (BIOMIE, SCF, ERP, CMS e n8n da VSB) ficam só nas redes dos próprios projetos, sem porta;
- o MAG AI não recebe credencial de banco, Omie ou Supabase: só modelo, limites e hashes das chaves.

**4. Backups**
- os 8 projetos do `vps-backup-run` com "OK (local + externo)" hoje entre 02:10 e 03:53;
- BIOMIE v2: backup cifrado há 12 h, 21 cópias fora do servidor, teste de restauração aprovado em 01/11
  (semanal, aos domingos às 03:50);
- base de tarefas: backup de hoje; BIOMIE antigo: 3 arquivos cifrados guardados;
- o MAG AI não toca em nenhum backup; o dele roda às 04:12, fora dos horários dos outros.

**5. Estabilidade**
- BIOMIE v2 na release 0273a021445e; web e worker saudáveis há 13 h; banco, API e autenticação há 311 h;
- monitor do BIOMIE sem aviso nas últimas 12 h; homologação parada;
- legado: `biomie-python` ainda ativo (sai no passo 2, noite de 06/11); nenhuma tarefa ativa no cron antigo.

**6. Reversão**
- `mag-ai.sh desfazer`: derruba só `mag-ai-ollama` e `mag-ai-gateway` e tira os 2 crons do MAG AI (~1 min);
- `mag-ai.sh comparar antes depois-desfazer`: prova que containers, portas, firewall, nginx, cron e redes de fora
  ficaram iguais;
- `mag-ai.sh remover --confirmo`: remoção total (documentos e chaves guardados em `/root/backups`);
- o **ensaio de reversão** faz parte da instalação.

## Condições de estabilidade conferidas antes de começar

1. `checklist` sem FALHA.
2. BIOMIE v2: a release ativada na noite de 05/11 (f4bbe45540f9), ou a anterior (0273a021445e) se a ativação não
   aconteceu; sem retorno pendente; web e worker no ar há mais de 6 h; sem aviso do monitor nas últimas 12 h.
3. Legado: passo 2 da desativação (noite de 06/11) concluído e sem retorno pendente, ou não previsto para esta
   madrugada. Os dois nunca rodam ao mesmo tempo. O passo 2 é leve (para um serviço que ninguém usa).
4. Nenhuma homologação nem ativação de outro sistema rodando ou prevista para 00:30–02:00 (confirmado em 05/11
   pelas sessões biomie-24 e biomie-83: nada delas nessa faixa nem em 04:30–05:00; a segunda reserva, 05:30–06:15,
   foi avisada às duas em 06/11). Nenhuma ativação do BIOMIE nas 6 h anteriores (web e worker no ar há mais de 6 h):
   uma ativação do gráfico na sexta à noite cancela a instalação.
5. Backups da madrugada anterior OK; último teste semanal de restauração aprovado (01/11).

Se qualquer condição falhar, a instalação fica para outra janela.

Leituras de estoque: o fechamento das 23:50 faz 5 leituras do Omie, com recálculo das curvas. Normalmente termina
entre 00:45 e 00:58, mas atravessa a madrugada quando o Omie fica instável: em 05→06/11 as leituras se repetiram e a
última terminou às 04:46 (informação da biomie-24 em 06/11 05:05). A carga do servidor ficou baixa o tempo todo
(0,2–0,6; banco com 12% de CPU), porque era espera de rede.

A consulta ao banco do BIOMIE que mostraria leitura em andamento foi bloqueada nesta sessão (leitura de produção), e
o log do BIOMIE também não é lido. Por isso a regra não depende de as leituras terem terminado:
- os passos pesados começam a partir de 01:01 (fim normal do fechamento) e só com o servidor folgado (carga de
  1 min abaixo de 1,0 e 3 GB livres);
- o Ollama fica limitado a 1 dos 2 processadores, com prioridade menor que a dos outros containers;
- o único recurso que as leituras realmente usam é a rede, e o MAG AI baixa ~2,6 GB uma única vez: ~1,6 GB no
  `construir` (pacote oficial de 1,5 GB, imagens base e pacotes do Debian) e ~1,0 GB no `modelo`, em poucos minutos;
- horário, carga, memória livre e bytes recebidos são registrados antes e depois do `construir` e do `modelo`, e o
  relatório mostra quando e quanto o MAG AI baixou, para comparação se alguma leitura falhar.

Os passos das 00:31 são leves.

## Roteiro da madrugada de sábado 07/11 (horário de Brasília)

| hora | passo | observação |
|---|---|---|
| sexta 22:07 | pré-checagem | `checklist` + condições acima, só leitura; aviso ao usuário antes de ele dormir |
| 00:31 | `checklist` + condições acima | portão; nada é gravado |
| ~00:35 | envio do pacote (hash conferido) + `verificar` (foto "antes") + `preparar` | leves; podem coincidir com as leituras de estoque |
| 01:01 | `construir` | 5–8 min; baixa o pacote oficial (~1,5 GB) e confere o SHA256; se o portão recusar por carga, vai para 01:31 |
| até 01:12 | `modelo` + `subir` | 2–4 min + 1 min (se passar de 01:12, o modelo vai para 01:31) |
| 01:31 | `testar` | começa até 01:42; sondas de rede + ponta a ponta + qualidade + desempenho, com vigia de memória |
| ~01:40 | `ensaiar-reversao` | desfazer → conferir → subir de novo |
| ~01:45 | `comparar antes depois` + `checklist` | prova final de que nada fora do MAG AI mudou; servidor livre antes das 02:10 |
| 04:31 | reserva | só o que tiver ficado para trás; termina antes da limpeza de imagens das 05:01 |
| 05:31 | segunda reserva | só o que ainda faltar (`testar` começa até 05:42; 06:00–06:12 ainda é permitido); termina antes do motor de inteligência do BIOMIE das 06:33 |
| manhã | relatório | publicado para o usuário |

Ficam de fora da madrugada os backups das 02:10–03:53, a limpeza de imagens das 05:01 e o motor de inteligência do
BIOMIE das 06:33. As leituras do fechamento de estoque podem coincidir (ver acima). O primeiro backup do próprio
MAG AI roda às 04:12. As cargas do worker do BIOMIE
(:21 e :51) não afetam a comparação antes × depois, que olha containers e configuração, não carga.

Limpeza de imagens: o cron das 05:01 apaga imagem sem nenhum container com mais de 24 h. As imagens do MAG AI ficam
protegidas enquanto os containers existirem; se a instalação for desfeita e ficar assim, a partir de 08/11 às 05:01
voltar exige `construir` de novo (o modelo continua no volume). As imagens base baixadas podem sair já em 07/11 às
05:01 e são baixadas de novo quando precisar.

Os passos pesados só começam entre :00–:12 ou :30–:42 (longe das cargas do BIOMIE às :21 e :51) e com o servidor
folgado. Se o portão recusar por carga, memória ou janela, isso não é falha: o passo fica para a etapa seguinte
(01:31, 04:31 ou 05:31). O BIOMIE v2, o ERPNext, o nginx e os outros sistemas não são alterados. O teste usa
containers descartáveis.

## Critérios de parada

- falha em qualquer passo → o roteiro para; se os containers já subiram, `desfazer`;
- memória disponível do servidor abaixo de 1.500 MB durante os testes → o vigia interrompe o teste → `desfazer`;
- Ollama perto do teto (acima de 2.400 MB) ou encerrado por falta de memória → `desfazer` e relatório;
- sonda de rede alcançando banco, serviço interno, internet ou outro projeto → `desfazer`;
- diferença fora do MAG AI na comparação que não seja de rotina agendada → `desfazer` e investigação.

## O que vem no relatório depois da instalação

- **CPU:** segundos de CPU do Ollama nos testes, uso durante a geração, carga máxima do servidor;
- **RAM:** Ollama parado, carregado e no pico; memória livre mínima do servidor; volta ao normal após os 2 min;
- **tempo de resposta:** total, carga, leitura e geração por pedido; tokens por segundo; primeira palavra em streaming;
- **qualidade:** respostas certas na bateria (nos fatos e fora deles), classificações certas, números inventados;
- **segurança:** chaves, API do Ollama fechada, imagem recusada, limites de tamanho, limite por minuto, fila, sondas
  (bancos, serviços, internet e outros projetos inalcançáveis), ponte sem endereço, nenhuma porta, nenhuma credencial;
- **impacto:** foto antes × depois (nenhum container de fora reiniciado; portas, firewall, nginx e cron iguais),
  avisos do monitor do BIOMIE na janela, memória e carga do servidor, horário e volume de cada download (o
  fechamento de estoque pode ter coincidido; isso não é verificável sem o banco do BIOMIE);
- **reversão:** tempo para voltar e resultado da comparação.
