# The full-flow test image: the Container Apps job caj-atlasrelay-<env>-e2e runs it.
# .github/workflows/e2e-dev.yml builds it from the repository root and pushes it to GHCR:
#
#   docker build -f e2e-real/Dockerfile .
#
# It holds the test code (e2e-real/ and the page steps it shares with the local tests,
# web/e2e/ui.ts) and Playwright, nothing else: the test accounts are read from Key Vault at run
# time. Dockerfile.dockerignore keeps the rest of the repository out of the build context.
#
# The base image and @playwright/test (package.json and its lockfile) must be the same version as
# web/package.json; e2e-real/test/versions.test.mjs checks it.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# zip and unzip: run.mjs rewrites trace archives to redact them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends zip unzip \
  && rm -rf /var/lib/apt/lists/*

# The same layout as the repository, so e2e-real/specs finds ../../web/e2e/ui.ts. /app/package.json
# (e2e-real's) makes both ES modules and holds @playwright/test.
WORKDIR /app
COPY e2e-real/package.json e2e-real/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
  && npm cache clean --force
COPY e2e-real/ e2e-real/
COPY web/e2e/ui.ts web/e2e/ui.ts

# The image's pwuser, not root.
RUN chown -R pwuser:pwuser /app
USER pwuser
ENV NODE_ENV=production
WORKDIR /app/e2e-real
ENTRYPOINT ["node", "run.mjs"]
