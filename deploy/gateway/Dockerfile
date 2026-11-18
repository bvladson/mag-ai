# MAG AI — gateway interno. (Sem linha "syntax": usa o interpretador embutido no Docker.) Node 24, sem dependências externas (só a biblioteca padrão).
# Contexto do build = raiz do projeto mag-ai:
#   docker build -t mag-ai-gateway:<versão> -f deploy/gateway/Dockerfile .
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production
WORKDIR /app
COPY gateway/package.json ./
COPY gateway/src ./src
USER 10080:10080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
