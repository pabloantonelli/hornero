ARG BUILD_FROM
FROM ${BUILD_FROM}

# Baileys 7 is ESM-only; p-queue 10 requires Node 22 or newer. ffmpeg turns
# audio into voice notes (Ogg/Opus) and images into stickers (WebP).
RUN apk add --no-cache nodejs npm ffmpeg \
    && node -e "if (+process.versions.node.split('.')[0] < 22) { console.error('Node 22+ required, got ' + process.version); process.exit(1) }"

WORKDIR /app

# Dependencies first, so the layer is cached while only sources change.
COPY package.json package-lock.json ./
# --ignore-scripts avoids running package install hooks, which crash under the
# QEMU emulation used to build the non-amd64 images.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY src/ ./src/
COPY custom_component/ /custom_component/
COPY run.sh finish.sh /
RUN chmod a+x /run.sh /finish.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD [ "/run.sh" ]
