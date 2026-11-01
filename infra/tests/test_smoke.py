"""smoke.py: the checks a deploy must pass, run here against a threaded HTTP stub of the hosted
Desk (the web build, the API's routes, a fast SSE heartbeat) and local sockets for the port
probes. Each bad stub breaks one property and the matching check must fail."""

import contextlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from botocore.stub import Stubber
from conftest import load_script, unsigned_client

PASSCODE = "smoke-passcode-5b1d93"  # a made-up passcode, never a real one
OWNER_TOKEN = "owner-token-a7c2e9f1"
VISITOR_TOKEN = "visitor-token-3e8b0d42"
SLUG = "turner-plumbing-1a2b"
ASSET = "/assets/index-4f2a9c.js"
INDEX = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Claude Desk</title>'
    f'<script type="module" crossorigin src="{ASSET}"></script></head><body><div id="root"></div></body></html>'
)
PLACEHOLDER = '<!doctype html><html><head><meta name="desk-site" content="placeholder"></head><body></body></html>'
HSTS = "max-age=31536000; includeSubDomains"
CLUSTER = "desk"
TASK_ARN = "arn:aws:ecs:us-west-2:123456789012:task/desk/0f1e2d3c4b5a69788a7b6c5d4e3f2a1b"
ENI = "eni-0a1b2c3d4e5f60718"
LOAD_BALANCER = "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/ecs-express-desk/0a1b2c3d4e5f6071"
LB_GROUP = "sg-0a1b2c3d4e5f60718"
CLOUDFRONT_LIST, OTHER_LIST = "pl-82a045eb", "pl-0f1e2d3c4b5a69788"
OWNER_COOKIE = f"desk_owner={OWNER_TOKEN}; Path=/api/owner; Max-Age=604800; HttpOnly; Secure; SameSite=Strict"
VISITOR_COOKIE = (
    f"desk_visitor={VISITOR_TOKEN}; Path=/api/public/desks/{SLUG}; Max-Age=86400; HttpOnly; Secure; SameSite=Strict"
)
HEALTH = {"ok": True, "kernel": {"version": "0.1.0", "proof_mode": "symcc", "dev_signing_key": False,
                                 "public_key_hex": "ab" * 32, "key_id": "k1", "unproved_seeds": []}}


@dataclass
class Behavior:
    """How the stub answers; the defaults are a good deploy."""

    index: str = INDEX
    hsts: bool = True
    asset: bool = True
    api_404_html: bool = False
    health: dict = field(default_factory=lambda: json.loads(json.dumps(HEALTH)))
    owner_cookie: str = OWNER_COOKIE
    visitor_cookie: str = VISITOR_COOKIE
    echo_forged_host: bool = False
    echo_secrets: bool = False  # answers with the passcode and tokens in bodies and headers
    heartbeat_s: float = 0.05
    heartbeats: int | None = None  # closes the stream after this many
    error_event: bool = False


class Stub:
    def __init__(self, behavior: Behavior) -> None:
        self.behavior = behavior
        self.stop = threading.Event()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args) -> None:
                pass

            def do_GET(self) -> None:
                stub.get(self)

            def do_POST(self) -> None:
                stub.post(self)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def send(self, handler, status: int, body: str | bytes, content_type: str, headers: dict | None = None,
             cookies: list[str] = ()) -> None:
        data = body.encode() if isinstance(body, str) else body
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            handler.send_header(name, value)
        for cookie in cookies:
            handler.send_header("Set-Cookie", cookie)
        handler.end_headers()
        handler.wfile.write(data)
        handler.close_connection = True

    def html_headers(self) -> dict:
        return {"Strict-Transport-Security": HSTS} if self.behavior.hsts else {}

    def echo(self) -> dict:
        return {"X-Echo": f"{PASSCODE} {OWNER_TOKEN} {VISITOR_TOKEN}"} if self.behavior.echo_secrets else {}

    def json(self, handler, status: int, value, cookies: list[str] = ()) -> None:
        if self.behavior.echo_secrets and isinstance(value, dict):
            value = {**value, "echo": [PASSCODE, OWNER_TOKEN, VISITOR_TOKEN]}
        self.send(handler, status, json.dumps(value), "application/json",
                  {**self.html_headers(), **self.echo()}, cookies)

    def get(self, handler) -> None:
        b, path = self.behavior, handler.path
        if path in ("/", "/index.html") or path.startswith("/d/"):
            self.send(handler, 200, b.index, "text/html", self.html_headers())
        elif path == ASSET and b.asset:
            self.send(handler, 200, "export {};", "application/javascript",
                      {"Cache-Control": "public, max-age=31536000, immutable", **self.html_headers()})
        elif path == "/api/health":
            self.json(handler, 200, b.health)
        elif path == f"/api/public/desks/{SLUG}/agent_card":
            host = handler.headers.get("X-Forwarded-Host") if b.echo_forged_host else None
            origin = f"https://{host}" if host else self.base_url
            self.json(handler, 200, {"endpoint": f"{origin}/api/a2a/{SLUG}", "signing": {}, "example_request": {}})
        elif path == f"/api/public/desks/{SLUG}/events":
            self.events(handler)
        elif path.startswith("/api/") and not b.api_404_html:
            self.json(handler, 404, {"detail": "Not Found"})
        else:
            # What a distribution-wide error response does: the app's page for any missing path.
            self.send(handler, 200 if path.startswith("/api/") else 404, b.index, "text/html", self.html_headers())

    def post(self, handler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        body = json.loads(handler.rfile.read(length) or b"{}")
        if handler.path == "/api/owner/copies":
            if body.get("passcode") != PASSCODE:
                self.json(handler, 401, {"error": "wrong_passcode", "got": body.get("passcode")})
                return
            copy = {"copy_id": "c-1", "desks": [{"desk_id": "d-1", "slug": SLUG, "name": "Turner's Desk",
                                                 "business_name": "Turner Plumbing", "hours": [], "answering": "ai"}]}
            self.json(handler, 201, copy, [self.behavior.owner_cookie])
        elif handler.path == f"/api/public/desks/{SLUG}/sessions":
            self.json(handler, 201, {"state": {}, "resumed": False}, [self.behavior.visitor_cookie])
        else:
            self.json(handler, 404, {"detail": "Not Found"})

    def events(self, handler) -> None:
        b = self.behavior
        if f"desk_visitor={VISITOR_TOKEN}" not in (handler.headers.get("Cookie") or ""):
            self.json(handler, 401, {"error": "no_session"})
            return
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        handler.close_connection = True

        def chunk(text: str) -> None:
            data = text.encode()
            handler.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            handler.wfile.flush()

        sent = 0
        try:
            if b.error_event:
                chunk('event: error\nid: 1\ndata: {"type": "error", "code": "internal"}\n\n')
            while not self.stop.is_set() and (b.heartbeats is None or sent < b.heartbeats):
                chunk(": keep-alive\n\n")
                sent += 1
                if b.heartbeats is None or sent < b.heartbeats:
                    time.sleep(b.heartbeat_s)
            handler.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def __enter__(self) -> "Stub":
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop.set()
        self.server.shutdown()
        self.server.server_close()


def closed_port() -> int:
    """A port nothing listens on: bound once, then released."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def listener():
    """A port that accepts connections, like an origin or task port left open."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(8)
    try:
        yield sock.getsockname()[1]
    finally:
        sock.close()


@pytest.fixture
def smoke(monkeypatch):
    """smoke.py with the timings shortened and the probed ports closed local ones."""
    module = load_script("smoke")
    monkeypatch.setattr(module, "SSE_SECONDS", 0.5)
    monkeypatch.setattr(module, "SSE_DEADLINE", 1.5)
    monkeypatch.setattr(module, "SSE_READ_TIMEOUT", 1.0)
    monkeypatch.setattr(module, "ORIGIN_PORTS", (closed_port(),))
    monkeypatch.setattr(module, "ORIGIN_TIMEOUT", 0.5)
    monkeypatch.setattr(module, "TASK_PORTS", (closed_port(), closed_port()))
    monkeypatch.setattr(module, "TASK_TIMEOUT", 0.5)
    return module


@pytest.fixture
def aws():
    clients = {name: unsigned_client(name) for name in ("ecs", "ec2", "elbv2")}
    stubs = {name: Stubber(client) for name, client in clients.items()}
    for stub in stubs.values():
        stub.activate()
    yield clients, stubs
    for stub in stubs.values():
        stub.deactivate()


APP_GROUP = "sg-0123456789abcdef0"
# DeskData's app group: the API on 8700 from the VPC's range, which holds the load balancer.
APP_RULES = [{"IpProtocol": "tcp", "FromPort": 8700, "ToPort": 8700,
              "IpRanges": [{"CidrIp": "10.0.0.0/16", "Description": "The API, from the load balancer in this VPC"}]}]


def expect_task(stubs, public_ip: str | None = "127.0.0.1", family: str = "desk", groups: list[str] | None = None,
                permissions: list[dict] | None = None, found: list[str] | None = None,
                group_error: str | None = None) -> None:
    """The describe calls task_ports_refused makes, in order; by default one app task in the app group.

    `found` is the groups the security group describe returns (the interface's, unless given), and
    `group_error` an error code that describe raises instead.
    """
    groups = [APP_GROUP] if groups is None else groups
    found = groups if found is None else found
    stubs["ecs"].add_response("list_tasks", {"taskArns": [TASK_ARN]}, {"cluster": CLUSTER, "desiredStatus": "RUNNING"})
    task = {
        "taskArn": TASK_ARN,
        "taskDefinitionArn": f"arn:aws:ecs:us-west-2:123456789012:task-definition/{family}:12",
        "lastStatus": "RUNNING",
        "attachments": [{"type": "ElasticNetworkInterface", "status": "ATTACHED",
                         "details": [{"name": "subnetId", "value": "subnet-0a1b2c3d4e5f60718"},
                                     {"name": "networkInterfaceId", "value": ENI}]}],
    }
    stubs["ecs"].add_response("describe_tasks", {"tasks": [task], "failures": []},
                              {"cluster": CLUSTER, "tasks": [TASK_ARN]})
    if family != "desk":
        return
    interface = {"NetworkInterfaceId": ENI, "PrivateIpAddress": "10.0.0.12",
                 "Groups": [{"GroupId": group, "GroupName": "desk-app"} for group in groups]}
    if public_ip is not None:
        interface["Association"] = {"PublicIp": public_ip}
    stubs["ec2"].add_response("describe_network_interfaces", {"NetworkInterfaces": [interface]},
                              {"NetworkInterfaceIds": [ENI]})
    if not groups:
        return
    if group_error is not None:
        stubs["ec2"].add_client_error("describe_security_groups", group_error, "not allowed")
        return
    stubs["ec2"].add_response(
        "describe_security_groups",
        {"SecurityGroups": [{"GroupId": group, "IpPermissions": APP_RULES if permissions is None else permissions}
                            for group in found]},
        {"GroupIds": groups},
    )


def cloudfront_443(prefix_list: str = CLOUDFRONT_LIST) -> dict:
    return {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "PrefixListIds": [{"PrefixListId": prefix_list}]}


def expect_balancer(stubs, permissions: list[dict] | None = None, groups: list[str] | None = None,
                    prefix_lists: list[str] | None = None) -> None:
    """The describe calls origin_groups_locked makes, in order; by default a locked balancer."""
    groups = [LB_GROUP] if groups is None else groups
    stubs["elbv2"].add_response(
        "describe_load_balancers",
        {"LoadBalancers": [{"LoadBalancerArn": LOAD_BALANCER, "SecurityGroups": groups}]},
        {"LoadBalancerArns": [LOAD_BALANCER]},
    )
    if not groups:
        return
    stubs["ec2"].add_response(
        "describe_managed_prefix_lists",
        {"PrefixLists": [{"PrefixListId": pl, "PrefixListName": "com.amazonaws.global.cloudfront.origin-facing"}
                         for pl in ([CLOUDFRONT_LIST] if prefix_lists is None else prefix_lists)]},
        {"Filters": [{"Name": "prefix-list-name", "Values": ["com.amazonaws.global.cloudfront.origin-facing"]}]},
    )
    if prefix_lists is not None and len(prefix_lists) != 1:
        return
    stubs["ec2"].add_response(
        "describe_security_groups",
        {"SecurityGroups": [{"GroupId": LB_GROUP,
                             "IpPermissions": [cloudfront_443()] if permissions is None else permissions}]},
        {"GroupIds": groups},
    )


def run(smoke, stub: Stub, *extra: str, passcode: str | None = PASSCODE, clients=None) -> int:
    environ = {} if passcode is None else {"DESK_PASSCODE": passcode}
    return smoke.main(["--base-url", stub.base_url, *extra], clients=clients, environ=environ)


def results(out: str) -> dict[str, str]:
    """Check name -> pass, FAIL, not run or skipped, from smoke's one line per check."""
    found = {}
    for line in out.splitlines():
        for status in ("pass", "FAIL", "not run", "skipped"):
            if line.startswith(f"{status} "):
                found[line[len(status) + 1:].split(":", 1)[0].strip()] = status
    return found


def test_all_checks_pass_against_a_good_stub(smoke, aws, capsys):
    clients, stubs = aws
    expect_balancer(stubs)
    expect_task(stubs)
    with Stub(Behavior()) as stub:
        status = run(smoke, stub, "--origin-host", "127.0.0.1", "--cluster", CLUSTER,
                     "--load-balancer-arn", LOAD_BALANCER, clients=clients)
    out = capsys.readouterr().out
    assert results(out) == {name: "pass" for name in smoke.CHECKS}, out
    assert status == 0


def test_api_404_masked_by_index_fails(smoke, capsys):
    with Stub(Behavior(api_404_html=True)) as stub:
        assert run(smoke, stub, "--only", "api_404_passes_through") == 1
    assert results(capsys.readouterr().out) == {"api_404_passes_through": "FAIL"}


def test_missing_security_headers_fails(smoke, capsys):
    with Stub(Behavior(hsts=False)) as stub:
        assert run(smoke, stub, "--only", "security_headers") == 1
    assert results(capsys.readouterr().out) == {"security_headers": "FAIL"}


def test_missing_asset_fails(smoke, capsys):
    with Stub(Behavior(asset=False)) as stub:
        assert run(smoke, stub, "--only", "assets_served") == 1
    assert results(capsys.readouterr().out) == {"assets_served": "FAIL"}


def test_placeholder_site_fails(smoke, capsys):
    """The labelled stand-in page means the web build never shipped."""
    with Stub(Behavior(index=PLACEHOLDER)) as stub:
        assert run(smoke, stub, "--only", "index_served") == 1
    out = capsys.readouterr().out
    assert results(out) == {"index_served": "FAIL"} and "placeholder" in out


@pytest.mark.parametrize(
    "change",
    [
        {"proof_mode": "bounded"},
        {"dev_signing_key": True},
        {"unproved_seeds": ["rivera"]},
        None,  # the kernel didn't answer
    ],
)
def test_api_health_requires_production_kernel(smoke, capsys, change):
    behavior = Behavior()
    if change is None:
        behavior.health = {"ok": False, "kernel": None}
    else:
        behavior.health["kernel"].update(change)
    with Stub(behavior) as stub:
        assert run(smoke, stub, "--only", "api_health") == 1
    assert results(capsys.readouterr().out) == {"api_health": "FAIL"}


@pytest.mark.parametrize(
    "behavior",
    [
        Behavior(heartbeats=6, heartbeat_s=0.0),  # enough heartbeats, but the stream closes at once
        Behavior(heartbeat_s=0.4),  # open long enough, too few heartbeats by the deadline
        Behavior(error_event=True),
    ],
    ids=["closes_early", "too_few", "error_event"],
)
def test_sse_check_needs_heartbeats_over_time(smoke, capsys, behavior):
    with Stub(behavior) as stub:
        assert run(smoke, stub, "--only", "sse_survives_idle") == 1
    assert results(capsys.readouterr().out) == {"sse_survives_idle": "FAIL"}


def test_sse_check_passes_with_steady_heartbeats(smoke, capsys):
    with Stub(Behavior()) as stub:
        started = time.monotonic()
        assert run(smoke, stub, "--only", "sse_survives_idle") == 0
        assert time.monotonic() - started >= smoke.SSE_SECONDS
    assert results(capsys.readouterr().out) == {"sse_survives_idle": "pass"}


@pytest.mark.parametrize("passing", [True, False])
def test_passcode_never_printed(smoke, aws, capsys, passing):
    """Neither the passcode nor a cookie's token is printed, even when the stub echoes them back
    or the passcode is refused."""
    clients, stubs = aws
    expect_task(stubs)
    with Stub(Behavior(echo_secrets=True)) as stub:
        run(smoke, stub, "--origin-host", "127.0.0.1", "--cluster", CLUSTER, clients=clients,
            passcode=PASSCODE if passing else PASSCODE + "-wrong")
    captured = capsys.readouterr()
    for secret in (PASSCODE, OWNER_TOKEN, VISITOR_TOKEN):
        assert secret not in captured.out + captured.err


def test_output_redacts_the_passcode_and_cookie_values(smoke, capsys):
    """A second guard behind never printing bodies: any line smoke prints has the passcode and every
    cookie value it has seen replaced."""
    with Stub(Behavior()) as stub:
        checker = smoke.Smoke(stub.base_url, passcode=PASSCODE, origin_host=None, cluster=None, clients=None)
        checker.copy()
        checker.visitor(SLUG)
        checker.say(f"{PASSCODE} {OWNER_TOKEN} {VISITOR_TOKEN}")
    out = capsys.readouterr().out
    assert out.strip() == "[redacted] [redacted] [redacted]"


def test_wrong_passcode_fails_the_signed_in_checks(smoke, capsys):
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--only", "cookies_first_party", passcode="not-the-passcode") == 1
    assert results(capsys.readouterr().out) == {"cookies_first_party": "FAIL"}


@pytest.mark.parametrize(
    "cookies",
    [
        {"owner_cookie": OWNER_COOKIE + "; Domain=cloudfront.net"},
        {"owner_cookie": OWNER_COOKIE.replace("; Secure", "")},
        {"owner_cookie": OWNER_COOKIE.replace("; HttpOnly", "")},
        {"owner_cookie": OWNER_COOKIE.replace("Path=/api/owner", "Path=/")},
        {"owner_cookie": OWNER_COOKIE.replace("SameSite=Strict", "SameSite=Lax")},
        {"owner_cookie": OWNER_COOKIE.replace("; SameSite=Strict", "")},
        {"owner_cookie": f"other=1; Path=/; HttpOnly; Secure; SameSite=Strict"},  # no owner cookie
        {"visitor_cookie": VISITOR_COOKIE + "; Domain=example.com"},
        {"visitor_cookie": VISITOR_COOKIE.replace("; HttpOnly", "")},
        {"visitor_cookie": VISITOR_COOKIE.replace("; Secure", "")},
        {"visitor_cookie": VISITOR_COOKIE.replace(f"Path=/api/public/desks/{SLUG}", "Path=/")},
        {"visitor_cookie": VISITOR_COOKIE.replace(f"Path=/api/public/desks/{SLUG}", "Path=/api/public/desks")},
        {"visitor_cookie": VISITOR_COOKIE.replace(f"desks/{SLUG}", "desks/other-desk")},
        {"visitor_cookie": VISITOR_COOKIE.replace(f"; Path=/api/public/desks/{SLUG}", "")},
        {"visitor_cookie": VISITOR_COOKIE.replace("; SameSite=Strict", "")},
        {"visitor_cookie": VISITOR_COOKIE.replace("SameSite=Strict", "SameSite=None")},
        {"visitor_cookie": VISITOR_COOKIE.replace("SameSite=Strict", "SameSite=Lax")},
    ],
    ids=["owner_domain", "owner_not_secure", "owner_not_httponly", "owner_path", "owner_samesite_lax",
         "owner_no_samesite", "no_owner", "visitor_domain", "visitor_not_httponly", "visitor_not_secure",
         "visitor_path_root", "visitor_path_every_desk", "visitor_path_other_desk", "visitor_no_path",
         "visitor_no_samesite", "visitor_samesite_none", "visitor_samesite_lax"],
)
def test_cookie_check_requires_first_party_flags(smoke, capsys, cookies):
    """Each cookie as the API plan's "Cookies carry only tokens" sets it: HttpOnly, Secure,
    SameSite=Strict and host-only, the owner's on /api/owner and the visitor's on its own Desk's
    public routes. Breaking any one fails the check."""
    with Stub(Behavior(**cookies)) as stub:
        assert run(smoke, stub, "--only", "cookies_first_party") == 1
    assert results(capsys.readouterr().out) == {"cookies_first_party": "FAIL"}


def test_cookie_check_names_each_cookies_scope(smoke, capsys):
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--only", "cookies_first_party") == 0
    out = capsys.readouterr().out
    assert "desk_owner: Secure, HttpOnly, SameSite=Strict, Path=/api/owner, no Domain" in out
    assert f"desk_visitor: Secure, HttpOnly, SameSite=Strict, Path=/api/public/desks/{SLUG}, no Domain" in out


def test_public_links_ignore_forged_hosts(smoke, capsys):
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--only", "public_links_use_public_url") == 0
    with Stub(Behavior(echo_forged_host=True)) as stub:
        assert run(smoke, stub, "--only", "public_links_use_public_url") == 1
    out = capsys.readouterr().out
    assert [line.split(" ", 1)[0] for line in out.splitlines() if "public_links_use_public_url:" in line] == [
        "pass", "FAIL"]
    assert "evil.example" in out


def test_open_ports_fail(smoke, aws, monkeypatch, capsys):
    clients, stubs = aws
    expect_task(stubs)
    with listener() as port, Stub(Behavior()) as stub:
        monkeypatch.setattr(smoke, "ORIGIN_PORTS", (closed_port(), port))
        monkeypatch.setattr(smoke, "TASK_PORTS", (closed_port(), port))
        status = run(smoke, stub, "--origin-host", "127.0.0.1", "--cluster", CLUSTER, "--only", "origin_direct_refused",
                     "--only", "task_ports_refused", clients=clients)
    assert status == 1
    out = capsys.readouterr().out
    assert results(out) == {"origin_direct_refused": "FAIL", "task_ports_refused": "FAIL"}
    assert f"127.0.0.1:{port}" in out


def test_unresolvable_origin_host_fails(smoke, capsys):
    """A host that doesn't resolve proves nothing about the origin, so the check fails closed."""
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--origin-host", "origin.desk.invalid", "--only", "origin_direct_refused") == 1
    assert results(capsys.readouterr().out) == {"origin_direct_refused": "FAIL"}


@pytest.mark.parametrize("case", ["no_public_ip", "no_app_task"])
def test_task_ports_fail_closed_without_a_task_to_probe(smoke, aws, capsys, case):
    clients, stubs = aws
    if case == "no_public_ip":
        expect_task(stubs, public_ip=None)
    else:
        expect_task(stubs, family="desk-admin")
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--cluster", CLUSTER, "--only", "task_ports_refused", clients=clients) == 1
    assert results(capsys.readouterr().out) == {"task_ports_refused": "FAIL"}


# The fallback's load balancer group, which the service gives a rule of its own on the app group.
ALB_GROUP_RULE = {"IpProtocol": "tcp", "FromPort": 8700, "ToPort": 8700,
                  "UserIdGroupPairs": [{"GroupId": "sg-0f0e0d0c0b0a09080", "UserId": "123456789012"}]}


@pytest.mark.parametrize("permissions", [APP_RULES, [*APP_RULES, ALB_GROUP_RULE]], ids=["express", "alb"])
def test_task_ports_refused_reads_the_task_groups(smoke, aws, capsys, permissions):
    """What the task's own groups admit, read with describe calls, beside the TCP probes, which a
    network that filters 8700 and 8701 would refuse too."""
    clients, stubs = aws
    expect_task(stubs, permissions=permissions)
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--cluster", CLUSTER, "--only", "task_ports_refused", clients=clients) == 0
    out = capsys.readouterr().out
    assert results(out) == {"task_ports_refused": "pass"}
    assert APP_GROUP in out


@pytest.mark.parametrize(
    "permissions",
    [
        [{**APP_RULES[0], "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 8701, "ToPort": 8701, "Ipv6Ranges": [{"CidrIpv6": "::/0"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}],
        [*APP_RULES, {"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}],
        [{**APP_RULES[0], "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 8000, "ToPort": 9000,
                      "IpRanges": [{"CidrIp": "203.0.113.0/24"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 8701, "ToPort": 8701,
                      "PrefixListIds": [{"PrefixListId": OTHER_LIST}]}],
        [*APP_RULES, {"IpProtocol": "-1", "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
                      "IpRanges": [{"CidrIp": "0.0.0.0/1"}, {"CidrIp": "128.0.0.0/1"}]}],
        [*APP_RULES, {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "Ipv6Ranges": [{"CidrIpv6": "::0/0"}]}],
    ],
    ids=["world_8700", "world_v6_8701", "world_22", "world_all_traffic", "public_8700", "public_range_over_8701",
         "prefix_list_8701", "public_all_traffic", "public_22", "world_halves_22", "world_v6_spelled_long_80"],
)
def test_task_ports_refused_fails_on_a_group_open_beyond_the_vpc(smoke, aws, capsys, permissions):
    """The probes refuse here (closed local ports); the groups alone fail the check."""
    clients, stubs = aws
    expect_task(stubs, permissions=permissions)
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--cluster", CLUSTER, "--only", "task_ports_refused", clients=clients) == 1
    out = capsys.readouterr().out
    assert results(out) == {"task_ports_refused": "FAIL"}
    assert APP_GROUP in out


@pytest.mark.parametrize("case", ["no_groups", "describe_error", "group_not_found"])
def test_task_ports_refused_fails_closed_without_the_groups(smoke, aws, capsys, case):
    clients, stubs = aws
    if case == "no_groups":
        expect_task(stubs, groups=[])
    elif case == "describe_error":
        expect_task(stubs, group_error="UnauthorizedOperation")
    else:
        expect_task(stubs, found=[])
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--cluster", CLUSTER, "--only", "task_ports_refused", clients=clients) == 1
    assert results(capsys.readouterr().out) == {"task_ports_refused": "FAIL"}


def test_the_passcode_is_taken_out_of_the_environment_it_came_from(smoke, capsys, monkeypatch):
    """Given DESK_PASSCODE in its own environment, as deploy.sh gives it, smoke.py signs in with it
    and takes it out of that environment, so no child it starts, boto3's helpers included, is given it."""
    monkeypatch.setenv("DESK_PASSCODE", PASSCODE)
    with Stub(Behavior()) as stub:
        assert smoke.main(["--base-url", stub.base_url, "--only", "cookies_first_party"]) == 0
    assert results(capsys.readouterr().out) == {"cookies_first_party": "pass"}
    left = os.environ.get("DESK_PASSCODE")      # a name, so a failure never shows the whole environment
    assert left is None
    child = subprocess.run([sys.executable, "-c", "import os; print('DESK_PASSCODE' in os.environ)"],
                           capture_output=True, text=True, check=True)
    assert child.stdout == "False\n"


def test_without_a_passcode_the_signed_in_checks_are_not_run(smoke, capsys):
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, passcode=None) == 2
    found = results(capsys.readouterr().out)
    assert {name for name, status in found.items() if status == "not run"} == {
        "cookies_first_party", "public_links_use_public_url", "sse_survives_idle"}
    probes = ("origin_groups_locked", "origin_direct_refused", "task_ports_refused")
    assert {name for name, status in found.items() if status == "skipped"} == set(probes)
    assert all(status == "pass" for name, status in found.items() if name not in smoke.SIGNED_IN_CHECKS + probes)


def test_only_runs_the_named_checks(smoke, capsys):
    with Stub(Behavior()) as stub:
        assert run(smoke, stub, "--only", "api_health", passcode=None) == 0
    assert results(capsys.readouterr().out) == {"api_health": "pass"}


def test_a_failure_wins_over_not_run(smoke, capsys):
    with Stub(Behavior(hsts=False)) as stub:
        assert run(smoke, stub, passcode=None) == 1


@pytest.mark.parametrize("check", ["task_ports_refused", "origin_groups_locked"])
def test_probe_checks_named_without_their_option_are_a_usage_error(smoke, capsys, check):
    with Stub(Behavior()) as stub, pytest.raises(SystemExit) as exit_:
        run(smoke, stub, "--only", check)
    assert exit_.value.code == 2


def _origin_groups(smoke, clients, stub) -> int:
    return run(smoke, stub, "--load-balancer-arn", LOAD_BALANCER, "--only", "origin_groups_locked", clients=clients)


def test_origin_groups_locked_passes_when_only_cloudfront_reaches_443(smoke, aws, capsys):
    """What the Express balancer's groups say, read with describe calls, so the result doesn't hang
    on this machine's network as the TCP probes do (those stay as a second signal)."""
    clients, stubs = aws
    expect_balancer(stubs)
    with Stub(Behavior()) as stub:
        assert _origin_groups(smoke, clients, stub) == 0
    out = capsys.readouterr().out
    assert results(out) == {"origin_groups_locked": "pass"}
    assert LB_GROUP in out and CLOUDFRONT_LIST in out


WORLD_443 = {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}
VPC_RANGE = "10.0.0.0/16"


def express_edge_kept() -> list[dict]:
    """A balancer group as ExpressEdge's lock leaves one (test_express_edge's
    test_replaces_world_ingress_with_the_prefix_list): CloudFront admitted on 443, the world's sources
    revoked, and the private ones kept: another group on 443, a VPC range on 80, and the group's
    reference to itself, which admits all traffic."""
    return [
        cloudfront_443(),
        {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
         "UserIdGroupPairs": [{"GroupId": "sg-0f0e0d0c0b0a09080", "UserId": "123456789012"}]},
        {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "IpRanges": [{"CidrIp": VPC_RANGE}]},
        {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": VPC_RANGE}]},
        {"IpProtocol": "-1", "UserIdGroupPairs": [{"GroupId": LB_GROUP, "UserId": "123456789012"}]},
    ]


def test_origin_groups_locked_passes_on_the_private_sources_express_edge_keeps(smoke, aws, capsys):
    """Express may leave private sources on its balancer's group, and the lock keeps them on purpose:
    traffic from them can only come from inside the VPC. A correct deploy's smoke passes on them."""
    clients, stubs = aws
    expect_balancer(stubs, permissions=express_edge_kept())
    with Stub(Behavior()) as stub:
        assert _origin_groups(smoke, clients, stub) == 0
    out = capsys.readouterr().out
    assert results(out) == {"origin_groups_locked": "pass"}, out


# The world, written other ways: two halves of every IPv4 address, and ::/0 spelled long.
WORLD_HALVES_22 = {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
                   "IpRanges": [{"CidrIp": "0.0.0.0/1"}, {"CidrIp": "128.0.0.0/1"}]}
WORLD_V6_LONG_80 = {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "Ipv6Ranges": [{"CidrIpv6": "::0/0"}]}
PUBLIC_22 = {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}


@pytest.mark.parametrize(
    "opened",
    [
        {**WORLD_443, "Ipv6Ranges": [{"CidrIpv6": "::/0"}]},
        {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80,
         "IpRanges": [{"CidrIp": "0.0.0.0/0"}, {"CidrIp": VPC_RANGE}]},
        WORLD_HALVES_22,
        WORLD_V6_LONG_80,
    ],
    ids=["world_443", "world_beside_the_vpc_on_80", "world_halves_22", "world_v6_spelled_long_80"],
)
def test_origin_groups_locked_fails_when_the_kept_sources_come_with_the_world(smoke, aws, capsys, opened):
    clients, stubs = aws
    expect_balancer(stubs, permissions=[*express_edge_kept(), opened])
    with Stub(Behavior()) as stub:
        assert _origin_groups(smoke, clients, stub) == 1
    out = capsys.readouterr().out
    assert results(out) == {"origin_groups_locked": "FAIL"}
    assert f"{LB_GROUP} admits port {opened['FromPort']} from anywhere" in out


def test_origin_groups_locked_reads_the_kept_sources_from_express_edge(smoke):
    """One rule for what may stay beside CloudFront's list, in the lock's own code, not a copy here."""
    edge = smoke.INFRA / "functions" / "express_edge" / "index.py"
    assert smoke._express_edge().kept_source.__code__.co_filename == str(edge)


@pytest.mark.parametrize(
    "permissions",
    [
        [cloudfront_443(), WORLD_443],
        [cloudfront_443(), {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80, "Ipv6Ranges": [{"CidrIpv6": "::/0"}]}],
        [cloudfront_443(), {"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}],
        [cloudfront_443(), {**WORLD_443, "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}],
        [cloudfront_443(), {**WORLD_443, "IpRanges": [{"CidrIp": VPC_RANGE}, {"CidrIp": "198.51.100.7/32"}]}],
        [cloudfront_443(), {**WORLD_443, "IpRanges": [{"CidrIp": "10.0.0.0/7"}]}],
        [cloudfront_443(), {**WORLD_443, "Ipv6Ranges": [{"CidrIpv6": "2001:db8::/32"}]}],
        [cloudfront_443(), {**WORLD_443, "FromPort": 400, "ToPort": 500, "IpRanges": [{"CidrIp": "192.0.2.0/24"}]}],
        [cloudfront_443(), cloudfront_443(OTHER_LIST)],
        [],
        [cloudfront_443(OTHER_LIST)],
        [express_edge_kept()[1]],
        [*express_edge_kept(), {"IpProtocol": "-1", "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}],
        [*express_edge_kept(), PUBLIC_22],
        [*express_edge_kept(), {"IpProtocol": "udp", "FromPort": 53, "ToPort": 53,
                                "IpRanges": [{"CidrIp": "198.51.100.0/24"}]}],
        [*express_edge_kept(), WORLD_HALVES_22],
        [*express_edge_kept(), WORLD_V6_LONG_80],
        [*express_edge_kept(), {"IpProtocol": "tcp", "FromPort": 80, "ToPort": 80,
                                "PrefixListIds": [{"PrefixListId": CLOUDFRONT_LIST}]}],
        [*express_edge_kept(), {"IpProtocol": "-1", "PrefixListIds": [{"PrefixListId": CLOUDFRONT_LIST}]}],
        [*express_edge_kept(), {**cloudfront_443(), "IpProtocol": "udp"}],
        [{**cloudfront_443(), "IpProtocol": "udp"}],
        [*express_edge_kept(), {**cloudfront_443(), "ToPort": 444}],
    ],
    ids=["world_443", "world_v6_80", "world_all_traffic", "public_cidr_443", "public_beside_private_443",
         "wider_than_private_443", "public_v6_443", "cidr_range_over_443", "other_prefix_list", "no_ingress",
         "only_another_prefix_list", "only_kept_sources", "public_all_traffic", "public_22", "public_udp_53",
         "world_halves_22", "world_v6_spelled_long_80", "cloudfront_on_80", "cloudfront_all_traffic",
         "cloudfront_udp_443", "only_cloudfront_udp_443", "cloudfront_tcp_443_444"],
)
def test_origin_groups_locked_fails_on_any_other_ingress(smoke, aws, capsys, permissions):
    clients, stubs = aws
    expect_balancer(stubs, permissions=permissions)
    with Stub(Behavior()) as stub:
        assert _origin_groups(smoke, clients, stub) == 1
    assert results(capsys.readouterr().out) == {"origin_groups_locked": "FAIL"}


@pytest.mark.parametrize("case", ["no_groups", "no_prefix_list", "two_prefix_lists", "describe_error"])
def test_origin_groups_locked_fails_closed(smoke, aws, capsys, case):
    clients, stubs = aws
    if case == "no_groups":
        expect_balancer(stubs, groups=[])
    elif case == "no_prefix_list":
        expect_balancer(stubs, prefix_lists=[])
    elif case == "two_prefix_lists":
        expect_balancer(stubs, prefix_lists=[CLOUDFRONT_LIST, OTHER_LIST])
    else:
        stubs["elbv2"].add_client_error("describe_load_balancers", "AccessDenied", "not allowed")
    with Stub(Behavior()) as stub:
        assert _origin_groups(smoke, clients, stub) == 1
    assert results(capsys.readouterr().out) == {"origin_groups_locked": "FAIL"}


def test_app_family_matches_the_task_definition(smoke, desk_stacks):
    """task_ports_refused probes tasks of the app task definition's family, never the admin task."""
    [definition] = [
        resource for resource in desk_stacks.template.find_resources("AWS::ECS::TaskDefinition").values()
        if {c["Name"] for c in resource["Properties"]["ContainerDefinitions"]} == {"kernel", "Main"}
    ]
    assert definition["Properties"]["Family"] == smoke.APP_FAMILY
