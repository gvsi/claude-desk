"""`python -m desk.kernel_service`: the kernel process on 127.0.0.1:8701 (`make kernel-serve`),
with the mock payments server as its supervised child on MOCKPAY_URL's port."""

import os
import sys

import uvicorn

from desk.kernel_service.app import serve_config

STARTUP_FAILURE = 3   # uvicorn's own exit code when an app refuses to start


def main() -> None:
    os.environ["MOCKPAY_SPAWN"] = "1"   # the kernel command always runs the mock payments server
    server = uvicorn.Server(serve_config())
    server.run()
    if not server.started:
        sys.exit(STARTUP_FAILURE)


if __name__ == "__main__":
    main()
