# syntax=docker/dockerfile:1

# Max Speech: OpenAI-compatible speech-to-text and text-to-speech, plus the live
# session WebSocket, on port 8790. Two targets:
#
#   docker build --target cpu  -t max-speech:cpu  speech-server
#   docker build --target cuda -t max-speech:cuda speech-server
#
#   docker run --rm -p 127.0.0.1:8790:8790 -e SPEECH_API_KEY=change-me -v max-speech-data:/data max-speech:cpu
#   docker run --rm --gpus all -p 127.0.0.1:8790:8790 -e SPEECH_API_KEY=change-me -v max-speech-data:/data max-speech:cuda
#
# SPEECH_API_KEY is required for `serve`: inside a container the server binds 0.0.0.0, and
# without a key it refuses every client that is not loopback. The entrypoint
# exits with an error when it is empty (`max-speech download` and `engines` need none).
# The port is SPEECH_PORT (default 8790); the entrypoint and the healthcheck both use it.
# Models download into /data/models on
# first start; keep /data on a volume. The mlx profile (Apple silicon) is not
# here: Docker on a Mac has no Metal. Use start-speech.command instead.
#
# Python 3.12 exactly (misaki does not support 3.13). The CPU runtime uses the
# python image; the CUDA runtime is an nvidia/cuda image (CUDA 12 + cuDNN 9, which
# CTranslate2 needs) with Python 3.12 from uv's managed builds.

ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.0@sha256:8f926a80debadba6f18442030df316c0e2b28d6af62d1292fb44b1c874173dc0
ARG CPU_BASE=python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
ARG CUDA_BASE=nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04@sha256:8aef630a54bc5c5146ae5ce68e6af5caa3df0fb690bb91544175c91f307e4356

FROM ${UV_IMAGE} AS uv

# ---- build: the locked, production-only virtualenv ---------------------------
FROM ${CPU_BASE} AS build-cpu
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
# Dependencies first, so source edits do not reinstall them.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --no-install-project
COPY README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

FROM ${CUDA_BASE} AS build-cuda
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_PYTHON_DOWNLOADS=automatic UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install 3.12 && uv sync --frozen --no-dev --no-editable --no-install-project
COPY README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ---- runtime ----------------------------------------------------------------
FROM ${CPU_BASE} AS cpu
# libgomp1: onnxruntime. Everything else (libsndfile, espeak-ng data) ships in wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --home-dir /home/speech --shell /usr/sbin/nologin speech \
    && mkdir -p /data && chown speech:speech /data
COPY --from=build-cpu /opt/venv /opt/venv
COPY --chmod=755 packaging/entrypoint.sh /usr/local/bin/max-speech-entrypoint
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    SPEECH_DATA_DIR=/data \
    SPEECH_PORT=8790
USER speech
WORKDIR /home/speech
VOLUME ["/data"]
EXPOSE 8790
# Healthy once the models have loaded. The first start downloads them, so the
# start period is long; failures inside it are not counted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20m --retries=3 \
    CMD ["python", "-c", "import json,os,sys,urllib.request as u; sys.exit(0 if json.load(u.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('SPEECH_PORT', '8790'), timeout=4)).get('ready') else 1)"]
ENTRYPOINT ["max-speech-entrypoint"]
CMD ["max-speech", "serve", "--host", "0.0.0.0"]

FROM ${CUDA_BASE} AS cuda
RUN useradd --uid 10001 --create-home --home-dir /home/speech --shell /usr/sbin/nologin speech \
    && mkdir -p /data && chown speech:speech /data
COPY --from=build-cuda /opt/python /opt/python
COPY --from=build-cuda /opt/venv /opt/venv
COPY --chmod=755 packaging/entrypoint.sh /usr/local/bin/max-speech-entrypoint
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    SPEECH_DATA_DIR=/data \
    SPEECH_PORT=8790 \
    SPEECH_PROFILE=cuda \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility
USER speech
WORKDIR /home/speech
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=20m --retries=3 \
    CMD ["python", "-c", "import json,os,sys,urllib.request as u; sys.exit(0 if json.load(u.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('SPEECH_PORT', '8790'), timeout=4)).get('ready') else 1)"]
ENTRYPOINT ["max-speech-entrypoint"]
CMD ["max-speech", "serve", "--host", "0.0.0.0"]
