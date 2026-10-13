FROM ubuntu:24.04

ARG CODEX_VERSION
ARG NODE_MAJOR=24
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git gnupg procps python3 ripgrep util-linux \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# ubuntu:24.04 ships an `ubuntu` user with uid 1000; the sandbox user takes that uid instead.
RUN userdel --remove ubuntu \
 && useradd --create-home --uid 1000 --shell /bin/bash botcode \
 && install -d -o botcode -g botcode /workspace /codex-home /botcode /botcode/attachments

COPY --chmod=0755 run sync /opt/botcode/bin/

USER botcode
ENV HOME=/home/botcode CODEX_HOME=/codex-home
WORKDIR /workspace
CMD ["sleep", "infinity"]
