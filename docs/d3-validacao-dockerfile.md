# MAG AI — D3: validação do Dockerfile do Ollama (05/11/2026)

Pedido: validar o Dockerfile personalizado, as dependências, os hashes oficiais e as permissões do container.
Feito sem Docker e sem tocar na VPS: o pacote oficial e a camada da imagem base foram baixados para uma pasta
isolada desta máquina e analisados por script (`analisa_pacote.py`, Python em modo isolado).

## 1. Hashes oficiais

| item | valor | conferido contra |
|---|---|---|
| pacote `ollama-linux-amd64.tar.zst` v0.40.14 (1.525.335.029 bytes) | sha256 `993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d` | valor fixado no Dockerfile = `sha256sum.txt` da release = hash publicado pelo GitHub = arquivo baixado |
| imagem base `debian:bookworm-slim` | índice `734a72b3…179bc` → amd64 `c67e92c8…f018` → camada `dd051e1b…63e3` (28,2 MB) | índice e camada baixados e com hash igual ao publicado |
| imagem do gateway `node:24-bookworm-slim` | índice `01d566e8…70e9` | fixada por digest no Dockerfile |
| modelo `qwen3.5:0.8b-q8_0` | manifesto `7c00f78a…2d25`; camadas modelo `889ea3b9…` e visão `5ba2eb9b…` | o passo `modelo` confere camada a camada depois do download |

O build repete as duas conferências do pacote (valor fixado e `sha256sum.txt`) e para se qualquer uma falhar.

## 2. O que entra na imagem (filtro do Dockerfile aplicado ao pacote real)

O pacote tem 80 entradas e 2.510 MB descompactados. Entram **47 arquivos, 78,9 MB**:

- `bin/ollama` (43,8 MB);
- 14 variantes da biblioteca de CPU (`libggml-cpu-*`), inclusive `zen4`, a do processador desta VPS;
- `libggml`, `libggml-base`, `libllama`, `libllama-common`, `libmtmd` (visão), `llama-server` e `llama-quantize`
  (o Ollama 0.40 executa o modelo pelo `llama-server`, a partir de `/usr/lib/ollama`);
- `libgomp` já embutida no pacote;
- as licenças (Go, llama.cpp, MLX, XGrammar e outras).

Ficam de fora `cuda_v12` (1.308 MB), `cuda_v13` (1.082 MB) e `vulkan` (41 MB). Não há outras pastas.
Imagem final esperada: ~160 MB (base Debian ~75 MB + 79 MB), contra 3,4 GB comprimidos da imagem oficial.

## 3. Dependências

Cabeçalho ELF de cada binário e biblioteca incluída:

| exigido | onde está |
|---|---|
| `libggml*`, `libllama*`, `libmtmd`, `libgomp` | no próprio pacote (procuradas pela pasta do arquivo, `RUNPATH $ORIGIN`) |
| `libc.so.6`, `libm.so.6`, `libpthread.so.0`, `libdl.so.2`, `libresolv.so.2`, `libstdc++.so.6`, `libgcc_s.so.1`, `ld-linux-x86-64.so.2` | na imagem base Debian 12 |

Versões de símbolos exigidas no máximo: `GLIBC_2.28`, `GLIBCXX_3.4.25`, `GCC_3.4`. Todas definidas nas bibliotecas
da base (Debian 12: glibc 2.36, libstdc++ do GCC 12). **Nenhuma faltando.**

Mudança feita a partir da análise: o `libgomp1` saiu da instalação (o pacote já traz a biblioteca). A imagem final
instala só `ca-certificates` (usado no download do modelo). O estágio de montagem usa `curl` e `zstd` e é descartado.

## 4. Configurações conferidas no código-fonte da 0.40.14 (`envconfig/config.go`)

Existem com esses nomes: `OLLAMA_NO_CLOUD`, `OLLAMA_NUM_PARALLEL` (padrão 1), `OLLAMA_MAX_QUEUE` (padrão 512),
`OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_KEEP_ALIVE` (padrão 5 min), `OLLAMA_HOST`,
`OLLAMA_MODELS` (padrão `$HOME/.ollama/models`). Não existe mais `OLLAMA_TMPDIR`: nada é extraído para `/tmp`.
O Vulkan vem ligado por padrão; o compose desliga (`OLLAMA_VULKAN=0`).

## 5. Permissões do container

| item | Ollama | gateway |
|---|---|---|
| usuário | 10434:10434, sem root | 10080:10080, sem root |
| sistema de arquivos | só leitura | só leitura |
| onde grava | volume `/home/ollama/.ollama` (modelos e chave do próprio Ollama) e `/tmp` em memória (128 MB, sem execução) | `/tmp` em memória (16 MB) |
| binários | do root (0755/0644): o processo não altera os próprios arquivos | idem |
| capacidades do Linux | nenhuma (`cap_drop: ALL`) e `no-new-privileges` | idem |
| processos | até 256 | até 64 |
| arquivo de aplicações | — | `apps.json` só leitura, dono root, grupo 10080, modo 640 (só hashes) |

## 6. O que só o domingo comprova

O build em si, o carregamento do modelo e o comportamento real com o sistema de arquivos só leitura. O roteiro
para no primeiro erro, e o passo `testar` confere tudo isso automaticamente.
