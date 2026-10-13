FROM ubuntu:24.04

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

# The desktop: Xvnc resizes to the Desktop tab, matchbox fills the screen with the focused
# window, and websockify serves noVNC. Ubuntu's chromium is a snap and Google Chrome has no
# arm64 Linux build, so the browser is Playwright's Chromium. This layer comes before Codex so
# a Codex update does not download Chromium again.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/botcode/playwright
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools matchbox-window-manager python3-websockify x11-utils \
 && npm install --global @playwright/mcp@0.0.83 @novnc/novnc@1.7.0 \
 && node /usr/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps --no-shell chromium \
 && ln -s "$(echo /opt/botcode/playwright/chromium-*/chrome-linux*/chrome)" /opt/botcode/chromium \
 && install -d /opt/botcode/desktop \
 && ln -s /usr/lib/node_modules/@novnc/novnc/core /usr/lib/node_modules/@novnc/novnc/vendor /opt/botcode/desktop/ \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

ARG CODEX_VERSION
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

# ubuntu:24.04 ships an `ubuntu` user with uid 1000; the sandbox user takes that uid instead.
RUN userdel --remove ubuntu \
 && useradd --create-home --uid 1000 --shell /bin/bash botcode \
 && install -d -o botcode -g botcode /workspace /codex-home /botcode /botcode/attachments

COPY --chmod=0755 run sync agent terminal desktop browser /opt/botcode/bin/
COPY --chmod=0644 desktop.html /opt/botcode/desktop/index.html
COPY --chmod=0644 playwright-mcp.json /opt/botcode/

USER botcode
ENV HOME=/home/botcode CODEX_HOME=/codex-home
WORKDIR /workspace
CMD ["sleep", "infinity"]
