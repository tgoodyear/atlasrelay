# The full-flow test image: the Container Apps job caj-atlasrelay-<env>-e2e runs it.
# .github/workflows/e2e-dev.yml and scripts/run-e2e.sh build it from the repository root in the
# environment's private container registry, with ACR Tasks (scripts/lib/e2e-job.sh):
#
#   az acr build -r <registry> -g <resource group> -f e2e-real/Dockerfile -t atlasrelay-e2e:<tag> .
#
# It holds the test code (e2e-real/ and the page steps it shares with the local tests,
# web/e2e/ui.ts) and Playwright, nothing else: the test accounts and RIPE Atlas keys are read from
# Key Vault at run time. Dockerfile.dockerignore keeps the rest of the repository out of the build
# context, for az acr build and docker build alike.
#
# The base image and @playwright/test (package.json and its lockfile) must be the same version as
# web/package.json; e2e-real/test/versions.test.mjs checks it.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f

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
