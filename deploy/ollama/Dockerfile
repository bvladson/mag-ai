# MAG AI — Ollama só com CPU. (Sem linha "syntax": usa o interpretador embutido no Docker, sem baixar imagem extra.)
#
# Montado a partir do pacote OFICIAL da versão (github.com/ollama/ollama/releases), conferido por SHA256
# contra o valor fixado aqui E contra o sha256sum.txt publicado na própria release. Ficam só o binário e as
# bibliotecas da raiz de lib/ollama (backends de CPU); saem cuda*, rocm*, vulkan* e mlx* (esta VPS não tem GPU).
# Validado em 05/11/2026 contra o pacote real (2.510 MB descompactados): entram 47 arquivos, 78,9 MB (binário,
# 14 variantes de CPU inclusive zen4, llama-server, libgomp embutida e licenças); saem cuda_v12 (1.308 MB),
# cuda_v13 (1.082 MB) e vulkan (41 MB). Exige no máximo GLIBC_2.28 e GLIBCXX_3.4.25: o Debian 12 atende.
# Imagem final esperada: ~160 MB (base Debian ~75 MB + 79 MB), contra 3,4 GB comprimidos da oficial (com CUDA).
#
# Build sem contexto (o Dockerfile vem pela entrada padrão):
#   docker build -t mag-ai-ollama:0.40.14-cpu - < deploy/ollama/Dockerfile
#
# Trocar de versão = mudar OLLAMA_VERSION e OLLAMA_SHA256 (valor da release) e refazer a homologação.

ARG BASE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${BASE} AS pacote
ARG OLLAMA_VERSION=0.40.14
ARG OLLAMA_SHA256=993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /w
RUN set -eu; \
    base="https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}"; \
    curl -fsSL --retry 3 -o pacote.tar.zst "${base}/ollama-linux-amd64.tar.zst"; \
    curl -fsSL --retry 3 -o sha256sum.txt "${base}/sha256sum.txt"; \
    echo "${OLLAMA_SHA256}  pacote.tar.zst" | sha256sum -c -; \
    grep -Eq "^${OLLAMA_SHA256}[[:space:]]+(\./)?ollama-linux-amd64\.tar\.zst$" sha256sum.txt; \
    tar --zstd -tf pacote.tar.zst > todos.txt; \
    grep -E '^(\./)?(bin/ollama|lib/ollama/.+)$' todos.txt \
      | grep -vE '/$' \
      | grep -vE '^(\./)?lib/ollama/(cuda|rocm|vulkan|mlx)[^/]*/' > membros.txt; \
    grep -Eq '^(\./)?bin/ollama$' membros.txt; \
    grep -Eq '^(\./)?lib/ollama/libggml-cpu' membros.txt; \
    mkdir -p /saida; \
    tar --zstd -xf pacote.tar.zst -C /saida -T membros.txt; \
    rm -f pacote.tar.zst; \
    echo "== incluidos:"; cat membros.txt; \
    echo "== pastas deixadas de fora:"; grep -E '^(\./)?lib/ollama/[^/]+/$' todos.txt || true; \
    du -sh /saida

FROM ${BASE}
ARG OLLAMA_VERSION=0.40.14
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10434 ollama \
 && useradd --uid 10434 --gid 10434 --home-dir /home/ollama --create-home --shell /usr/sbin/nologin ollama \
 && mkdir -p /home/ollama/.ollama \
 && chown -R 10434:10434 /home/ollama
COPY --from=pacote /saida/bin/ollama /usr/bin/ollama
COPY --from=pacote /saida/lib/ollama/ /usr/lib/ollama/
ENV HOME=/home/ollama \
    OLLAMA_HOST=0.0.0.0:11434
USER 10434:10434
EXPOSE 11434
LABEL org.opencontainers.image.title="mag-ai-ollama" \
      org.opencontainers.image.description="Ollama ${OLLAMA_VERSION} somente CPU, a partir do pacote oficial conferido por SHA256" \
      org.opencontainers.image.version="${OLLAMA_VERSION}-cpu"
ENTRYPOINT ["/usr/bin/ollama"]
CMD ["serve"]
