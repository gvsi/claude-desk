"""Print a `PASSCODE_HASH` for the demo passcode, which is read without echoing it.

At a terminal it asks twice; otherwise it reads the first line of stdin. Only the hash is printed, so it can be
piped straight into a secret, from backend/:

    uv run python scripts/hash_passcode.py
    uv run python scripts/hash_passcode.py | <a command that stores the secret from stdin>
"""

import getpass
import sys

from desk.api.passcode import hash_passcode


def read_passcode() -> str:
    if sys.stdin.isatty():
        first = getpass.getpass("Passcode: ")
        if getpass.getpass("Once more: ") != first:
            raise SystemExit("hash_passcode: the two entries differ")
        return first
    return sys.stdin.readline().removesuffix("\n").removesuffix("\r")


def main() -> None:
    passcode = read_passcode()
    if not passcode:
        raise SystemExit("hash_passcode: the passcode is empty")
    print(hash_passcode(passcode))


if __name__ == "__main__":
    main()
