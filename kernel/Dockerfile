# syntax=docker/dockerfile:1.7
# The kernel image's Rust parts on Python 3.13, linux/arm64 (Fargate Graviton):
# the desk_kernel wheel, the desk-prove binary and the cvc5 solver.
#
#   docker buildx build --load --platform linux/arm64 -f kernel/Dockerfile -t desk-kernel:dev .
#
# Two stages: a rustup builder, and a slim runtime that holds only the three.

ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:281d39ff02e3b389401586134ff9e6572954687822a58055ec07a60ded4e0b7f

FROM ${PYTHON_IMAGE} AS build
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gcc libc6-dev unzip \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.99.1
ENV PATH=/root/.cargo/bin:$PATH
RUN pip install --no-cache-dir --root-user-action=ignore maturin==1.15.0

# cvc5 1.4.2, the static build without GPL components, pinned by URL and sha256.
ARG CVC5_URL=https://github.com/cvc5/cvc5/releases/download/cvc5-1.4.2/cvc5-Linux-arm64-static.zip
ARG CVC5_SHA256=765ebee59d9e5efccb60a445fa66fbddfb07a8de9fe7a5b6d128e5c2aafec974
RUN test "$TARGETARCH" = "arm64" || { echo "cvc5 is pinned for linux/arm64 only" >&2; exit 1; } \
 && curl -sSfL -o /tmp/cvc5.zip "$CVC5_URL" \
 && echo "$CVC5_SHA256  /tmp/cvc5.zip" | sha256sum -c - \
 && unzip -q /tmp/cvc5.zip -d /tmp \
 && mv /tmp/cvc5-Linux-arm64-static /opt/cvc5 \
 && rm /tmp/cvc5.zip

WORKDIR /src
COPY kernel kernel
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/src/kernel/target \
    maturin build --release --locked -m kernel/py/Cargo.toml -o /wheels \
 && cargo build --release --locked --manifest-path kernel/Cargo.toml -p desk-prove \
 && cp kernel/target/release/desk-prove /usr/local/bin/desk-prove

FROM ${PYTHON_IMAGE}
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir --root-user-action=ignore /wheels/*.whl && rm -rf /wheels
COPY --from=build /usr/local/bin/desk-prove /usr/local/bin/desk-prove
COPY --from=build /opt/cvc5/bin/cvc5 /usr/local/bin/cvc5
COPY --from=build /opt/cvc5/COPYING /opt/cvc5/licenses/ /usr/local/share/licenses/cvc5/
ENV CVC5=/usr/local/bin/cvc5
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin desk
USER desk
