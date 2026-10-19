# syntax=docker/dockerfile:1.7

# Instant Mashup: Bun server + React app, with the Python audio tools (librosa analysis,
# Demucs stem separation on CPU, yt-dlp) preinstalled in one venv and the Demucs model baked in,
# so a fresh container needs no package or model downloads at runtime.
#
# linux/amd64 only: Demucs 4.1 depends on sphn, which publishes Linux wheels for x86-64 only.

FROM ghcr.io/astral-sh/uv:0.12.3 AS uv
FROM denoland/deno:bin-2.5.6 AS deno

FROM oven/bun:1.4.0-slim AS python-tools
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1
# Same Python and package versions as local development (see analysis/analyze.py and server/config.ts).
# --torch-backend cpu keeps the multi-gigabyte CUDA builds of PyTorch out of the image.
RUN uv venv /opt/venv --python 3.11 \
 && uv pip install --python /opt/venv/bin/python --torch-backend cpu \
      "demucs==4.1.0" "soundfile>=0.12" \
      "librosa==0.11.0" "numpy>=1.26,<3" "scipy>=1.11" \
      "yt-dlp[default]==2026.08.19"
# Bake the htdemucs weights into the image.
ENV TORCH_HOME=/opt/models/torch HF_HOME=/opt/models/hf
RUN /opt/venv/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

FROM oven/bun:1.4.0-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=python-tools /opt/python /opt/python
COPY --from=python-tools /opt/venv /opt/venv
COPY --from=python-tools /opt/models /opt/models

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY analysis ./analysis
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tsconfig.json ./
RUN mkdir -p /app/data && chown bun:bun /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5180 \
    DATA_DIR=/app/data \
    PYTHON_VENV=/opt/venv \
    TORCH_HOME=/opt/models/torch \
    HF_HOME=/opt/models/hf \
    HF_HUB_OFFLINE=1 \
    NUMBA_CACHE_DIR=/tmp/numba \
    PATH="/opt/venv/bin:${PATH}"

USER bun
VOLUME /app/data
EXPOSE 5180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:5180/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# tini reaps the Python and ffmpeg child processes and passes stop signals on.
ENTRYPOINT ["tini", "--"]
CMD ["bun", "server/index.ts"]
