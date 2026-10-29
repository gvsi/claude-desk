# syntax=docker/dockerfile:1.7
# The app image, linux/arm64: the backend layered on the kernel image. One image runs both
# containers of the Fargate task (the kernel and the API) and the one-off admin task; each
# container's command picks the process.
#
#   make image KERNEL_TAG=<tag>   (builds desk-kernel:<tag>, then this with
#                                  --build-arg KERNEL_IMAGE=desk-kernel:<tag>; the tag is dev unless
#                                  given, and deploy.sh gives the commit)
#
# The kernel image (kernel/Dockerfile) holds the desk_kernel wheel in the system interpreter,
# desk-prove, cvc5 and the user desk (uid 10001). The backend's locked dependencies go into that
# same interpreter; the backend itself runs from /app/backend, uninstalled, so the kernel finds
# kernel/cedar/ (rules, schema and the shipped proof reports) at /app/kernel/cedar from its package
# path. The build context is the repo root, filtered by .dockerignore.

ARG KERNEL_IMAGE
FROM ${KERNEL_IMAGE}

USER root

# The backend's runtime dependencies exactly as uv.lock pins them, hash-checked, leaving out the
# backend project (run from source) and desk-kernel (already installed from the kernel image's
# wheel). uv is mounted for this step only, and its cache is off, so neither stays in the image.
RUN --mount=from=ghcr.io/astral-sh/uv:0.13.0@sha256:cdc6093146eb3ff6a40107b38f008b789e050e77ad87865e381d9917da55a168,source=/uv,target=/usr/local/bin/uv \
    --mount=type=bind,source=backend/pyproject.toml,target=/tmp/backend/pyproject.toml \
    --mount=type=bind,source=backend/uv.lock,target=/tmp/backend/uv.lock \
    export UV_NO_CACHE=1 UV_PYTHON_DOWNLOADS=never \
 && cd /tmp/backend \
 && uv export --frozen --no-dev --no-emit-project --no-emit-package desk-kernel -o /tmp/requirements.txt \
 && uv pip install --system --require-hashes --compile-bytecode -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

COPY backend /app/backend
COPY kernel/cedar /app/kernel/cedar

ENV PYTHONPATH=/app/backend \
    PYTHONUNBUFFERED=1
WORKDIR /app/backend
USER desk
ENTRYPOINT ["python", "-m", "desk.ops.entrypoint"]
