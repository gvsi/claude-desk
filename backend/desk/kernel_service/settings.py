"""Kernel settings: credentials are read here and excluded from representations."""

import os
import re
from dataclasses import dataclass, field

from desk.db.session import database_url


MOCKPAY_URL = "http://127.0.0.1:8702"


@dataclass(frozen=True)
class KernelSettings:
    database_url: str = field(repr=False)   # carries the role's password
    env: str = "dev"                        # DESK_ENV
    decisions: str = "anthropic"            # DESK_DECISIONS: "anthropic", or "offline" (a test hook)
    mockpay_url: str = MOCKPAY_URL          # MOCKPAY_URL: the mock payments server the kernel calls
    mockpay_key: str = field(default="", repr=False)   # MOCKPAY_KEY: the kernel's alone, never the API's
    mockpay_spawn: bool = False             # MOCKPAY_SPAWN=1: run that server as the kernel's child
    typesafe_api_key: str = field(default="", repr=False)  # optional second reply checker, kernel only
    sample_week: bool = False               # SAMPLE_WEEK=1: each new copy that asks opens on the sample week

    def __post_init__(self) -> None:
        if self.typesafe_api_key and not re.fullmatch(r"[!-~]+", self.typesafe_api_key):
            raise ValueError("TYPESAFE_API_KEY must be one printable ASCII token with no spaces")

    @classmethod
    def from_env(cls) -> "KernelSettings":
        typesafe_key = os.environ.get("TYPESAFE_API_KEY", "")
        if typesafe_key.strip().lower() in ("", "unset"):
            typesafe_key = ""
        return cls(database_url=database_url("KERNEL"), env=os.environ.get("DESK_ENV", "dev"),
                   decisions=os.environ.get("DESK_DECISIONS", "anthropic"),
                   mockpay_url=os.environ.get("MOCKPAY_URL") or MOCKPAY_URL,
                   mockpay_key=os.environ.get("MOCKPAY_KEY", ""), mockpay_spawn=os.environ.get("MOCKPAY_SPAWN") == "1",
                   typesafe_api_key=typesafe_key, sample_week=os.environ.get("SAMPLE_WEEK") == "1")
