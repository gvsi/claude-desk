"""`python -m desk.kernel_service`: the kernel process on 127.0.0.1:8701 (`make kernel-serve`)."""

import sys

import uvicorn

from desk.kernel_service.app import serve_config

STARTUP_FAILURE = 3   # uvicorn's own exit code when an app refuses to start


def main() -> None:
    server = uvicorn.Server(serve_config())
    server.run()
    if not server.started:
        sys.exit(STARTUP_FAILURE)


if __name__ == "__main__":
    main()
