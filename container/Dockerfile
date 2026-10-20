FROM node:22-bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

# git/curl are worker prerequisites; tini gives the long-running container a
# real PID 1 without privileged mode or a Docker socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git procps tini \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 colony \
 && useradd --uid 10001 --gid colony --create-home --shell /bin/bash colony

WORKDIR /opt/colony
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY src ./src
RUN chmod 0755 /opt/colony/src/cli.mjs \
 && ln -s /opt/colony/src/cli.mjs /usr/local/bin/colony \
 && chown -R colony:colony /opt/colony

USER colony
ENV COLONY_HOME=/home/colony/.super-colony \
    IDENTITYMD_HOME=/home/colony/.identitymd \
    npm_config_update_notifier=false
WORKDIR /home/colony

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["colony", "worker", "--help"]
