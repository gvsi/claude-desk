"""The API process's boundaries: what it may import, and what its kernel client may never log."""

import ast
import json
import logging
import subprocess
import sys
import threading
import traceback
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

import desk.api
from desk.api.kernel_client import KernelFailed, KernelHttp, KernelUnavailable
from desk.contracts import AgentAuth, SessionState
from desk.kernel_api import PaymentLinkView, VerifyCheckRequest, WhoAmI

BACKEND = Path(__file__).resolve().parents[2]
API = Path(desk.api.__file__).parent
# The API shares desk.always_on, desk.calendar, desk.contracts, desk.env, desk.events, desk.kernel_api, desk.money_cap,
# desk.presets and desk.rewrites with the kernel, and nothing else of it.
FORBIDDEN = ("desk.kernel_service", "desk_kernel", "desk.mockpay", "tests")


def imported_modules(source: str, package: str) -> set[str]:
    """Every module a source file imports: import statements, relative ones resolved, and import_module("...")."""
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            names |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = package.split(".")
                base = ".".join([*parts[:len(parts) - node.level + 1], *([node.module] if node.module else [])])
            names |= {base, *(f"{base}.{alias.name}" for alias in node.names)}
        elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant):
            function = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
            if function in ("import_module", "__import__") and isinstance(node.args[0].value, str):
                names.add(node.args[0].value)
    return names


def forbidden(names: set[str]) -> set[str]:
    return {name for name in names if any(name == bad or name.startswith(bad + ".") for bad in FORBIDDEN)}


def test_api_never_imports_the_kernel():
    # The scan finds each way of importing, so a clean result means something.
    assert forbidden(imported_modules(
        "import desk_kernel\nfrom desk import kernel_service\nfrom ..mockpay import server\n"
        "importlib.import_module('tests.api.fakes')\n", "desk.api")) == {
        "desk_kernel", "desk.kernel_service", "desk.mockpay", "desk.mockpay.server", "tests.api.fakes"}

    sources = sorted(API.rglob("*.py"))
    assert {"kernel_client.py", "settings.py"} <= {path.name for path in sources}
    for path in sources:
        package = ".".join(path.relative_to(BACKEND).parent.parts)
        assert not forbidden(imported_modules(path.read_text(), package)), path

    # And at run time: importing every module of desk.api loads none of them, not even through a shared module.
    loaded = subprocess.run(
        [sys.executable, "-c",
         "import importlib, json, pkgutil, sys; import desk.api\n"
         "for module in pkgutil.walk_packages(desk.api.__path__, 'desk.api.'): importlib.import_module(module.name)\n"
         "print(json.dumps(sorted(sys.modules)))"],
        cwd=BACKEND, capture_output=True, text=True, check=True)
    modules = set(json.loads(loaded.stdout))
    assert "desk.api.kernel_client" in modules
    assert not forbidden(modules)


# Values that must never reach a log line or an exception's text.
SESSION_TOKEN = "session-secret-a1"
OWNER_TOKEN = "owner-secret-b2"
AGENT = AgentAuth(agent_key_id="agent-key-secret-c3", ts="2026-10-30T17:04:05.123000Z", nonce="nonce-secret-d4",
                  sig="sig-secret-e5")
BODY_SHA256 = "5e" * 32
LINK_TOKEN = "link-secret-f6"
DOCUMENT_TOKEN = "document-secret-g7"
CODE = "code-secret-h8"
SECRETS = (SESSION_TOKEN, OWNER_TOKEN, AGENT.agent_key_id, AGENT.nonce, AGENT.sig, BODY_SHA256, LINK_TOKEN,
           DOCUMENT_TOKEN, CODE)

STATE = SessionState(session_id="s1", kind="visitor", verified=False, assurance="none", mode="ai", generation=0)
WHOAMI = WhoAmI(kind="visitor", copy_id="c1", desk_id="d1", desk_ids=["d1"], session=STATE)
LINK = PaymentLinkView(title="Drain clearing deposit", amount_cents=2000, state="issued", language="en",
                       business_name="Turner Plumbing", customer_name=None)


class KernelHandler(BaseHTTPRequestHandler):
    """A kernel on a real socket, so httpx's network transport and httpcore's debug logging both run."""

    def log_message(self, *args) -> None:
        pass

    def answer(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.startswith("/whoami"):
            self.answer(200, WHOAMI.model_dump_json().encode())
        elif self.path.startswith("/payment_links/"):
            self.answer(200, LINK.model_dump_json().encode())
        elif self.path.startswith("/document_links/"):
            self.answer(200, b"%PDF-1.7 invoice", "application/pdf")
        else:
            self.answer(404, b'{"code": "not_found"}')

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.answer(401, b'{"code": "auth"}')


@pytest.fixture
def kernel_url() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), KernelHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()


def shown(error: BaseException) -> str:
    return "".join(traceback.format_exception(error)) + repr(error)


@pytest.fixture
def unredacted_logs() -> Iterator[None]:
    """Log records as Python makes them: without the link-token redaction an app built earlier in the process installs
    (`log_redaction`), so the kernel client's own quieting is what a test checks."""
    factory = logging.getLogRecordFactory()
    logging.setLogRecordFactory(logging.LogRecord)
    try:
        yield
    finally:
        logging.setLogRecordFactory(factory)


async def test_kernel_client_never_logs_credentials(kernel_url, caplog, unredacted_logs):
    caplog.set_level(logging.DEBUG)
    async with httpx.AsyncClient(base_url=kernel_url) as plain:      # the control: httpx logs are captured here
        await plain.get("/payment_links/control-token-z9")
    assert "control-token-z9" in caplog.text
    assert any(record.name.startswith("httpcore.") for record in caplog.records)
    caplog.clear()

    errors: list[BaseException] = []
    async with KernelHttp(kernel_url) as http:
        session, owner, agent = http.session(SESSION_TOKEN), http.owner(OWNER_TOKEN), http.agent(AGENT, BODY_SHA256)
        assert await session.whoami() == WHOAMI
        assert await owner.whoami() == WHOAMI
        assert await agent.whoami(session_id="s1") == WHOAMI
        assert await http.public().call("GET /payment_links/{token}", path={"token": LINK_TOKEN}) == LINK
        async with http.public().stream("GET /document_links/{token}", {"token": DOCUMENT_TOKEN}) as document:
            assert await document.aread() == b"%PDF-1.7 invoice"
        with pytest.raises(KernelFailed) as refused:
            await session.call("POST /verify/check", VerifyCheckRequest(session_id="s1", code=CODE))
        errors.append(refused.value)
        views = repr((session, owner, agent))
    async with KernelHttp("http://127.0.0.1:9") as closed:          # nothing listens on the discard port
        with pytest.raises(KernelUnavailable) as unreachable:
            await closed.session(SESSION_TOKEN).call("POST /verify/check",
                                                     VerifyCheckRequest(session_id="s1", code=CODE))
        errors.append(unreachable.value)

    assert unreachable.value.__cause__ is None and unreachable.value.__suppress_context__
    logged = caplog.text + "".join(record.getMessage() for record in caplog.records)
    for secret in SECRETS:
        assert secret not in logged
        assert secret not in views
        for error in errors:
            assert secret not in shown(error)
