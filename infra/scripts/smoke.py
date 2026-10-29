"""Smoke-check a deployed Desk through its public address, as a visitor's browser reaches it.

    read -rs DESK_PASSCODE; export DESK_PASSCODE
    uv run --project infra python infra/scripts/smoke.py --base-url https://<PublicUrl host> \\
      [--origin-host <ServiceEndpoint host>] [--load-balancer-arn <LoadBalancerArn>] [--cluster desk] \\
      [--only <check>]...

deploy.sh runs every check after each deploy; `make image-smoke` runs `api_health` against a
local container. One line per check: `pass`, `FAIL`, `not run` (the signed-in checks without
`DESK_PASSCODE`) or `skipped` (a probe without its option). The passcode comes only from the
environment, and neither it nor a cookie's token is ever printed.

Checks, in order:
- index_served: `/` is the web app's HTML, not the labelled placeholder.
- spa_route_served: an app route (`/d/does-not-exist`) serves the same HTML.
- assets_served: a script under `/assets/` named in that HTML is JavaScript, cached `immutable`.
- api_404_passes_through: `/api/does-not-exist` is the API's 404, not the app's page.
- api_health: `/api/health` is ok, the kernel proves with SymCC, signs with the production key,
  and every seed is proved.
- security_headers: HSTS on `/` and `/api/health`.
- origin_groups_locked (`--load-balancer-arn`): the Express load balancer's security groups, read
  with describe calls, admit CloudFront's origin-facing prefix list on TCP 443, which at least one
  rule does, and otherwise, on any protocol or port, only the private sources ExpressEdge's lock
  keeps (its `kept_source`: another group, or a range inside the private ranges). Ranges are
  judged as address ranges, so the world written another way (0.0.0.0/1 with 128.0.0.0/1, ::0/0)
  fails as 0.0.0.0/0 does, and so does any public range.
- origin_direct_refused (`--origin-host`): the Express origin takes no TCP connection on 443 or
  80 from here; only CloudFront reaches it. A second signal beside origin_groups_locked: a network
  that filters these ports would refuse them too.
- task_ports_refused (`--cluster`): each running app task's security groups, read with describe
  calls, admit only those same private sources, on any protocol or port; and its public IP takes
  no connection on 8700 or 8701, the second signal.
- cookies_first_party (`DESK_PASSCODE`): a new copy's cookies are Secure, HttpOnly, SameSite=Strict
  and host-only; the owner cookie's path is /api/owner, the visitor cookie's its own Desk's
  /api/public/desks/{slug}.
- public_links_use_public_url (`DESK_PASSCODE`): the copy's agent card endpoint starts with the
  base URL, also when the request forges X-Desk-Public-Host and X-Forwarded-Host.
- sse_survives_idle (`DESK_PASSCODE`): a visitor's event stream stays open past CloudFront's
  60 s origin read timeout on heartbeats alone, with no error event.

Exit status: 0 every check run passed, 1 any failed, 2 the signed-in checks weren't run (no
`DESK_PASSCODE`) or a usage error.
"""

import argparse
import functools
import http.client
import importlib.util
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from urllib.parse import quote, urlsplit

REGION = "us-west-2"
INFRA = Path(__file__).resolve().parents[1]
# ExpressEdge's handler, whose kept_source names the private sources its lock leaves on purpose.
EXPRESS_EDGE = INFRA / "functions" / "express_edge" / "index.py"

# The routes the checks read: the edge's web build, and the API's routes from Plan 02 (Task 3:
# health and copies; Task 7: the agent card and the visitor session and stream).
ROUTES = {
    "index": "/",
    "spa_route": "/d/does-not-exist",
    "api_missing": "/api/does-not-exist",
    "api_health": "/api/health",
    "owner_copies": "/api/owner/copies",
    "agent_card": "/api/public/desks/{slug}/agent_card",
    "visitor_sessions": "/api/public/desks/{slug}/sessions",
    "visitor_events": "/api/public/desks/{slug}/events",
}
# The cookies as the API core plan (plan 02a) sets them in "Cookies carry only tokens": both
# HttpOnly, Secure and SameSite=Strict, the owner's on the owner routes and the visitor's on its own
# Desk's public routes.
OWNER_COOKIE, OWNER_COOKIE_PATH = "desk_owner", "/api/owner"
VISITOR_COOKIE, VISITOR_COOKIE_PATH = "desk_visitor", "/api/public/desks/{slug}"
FORGED_HOST = "evil.example"
FORGED_HEADERS = {"X-Desk-Public-Host": FORGED_HOST, "X-Forwarded-Host": FORGED_HOST}
# The app task definition's family (infra/stacks/task.py); the admin task's is desk-admin.
APP_FAMILY = "desk"
# AWS's managed list of the addresses CloudFront reaches origins from (as DeskData looks it up).
CLOUDFRONT_ORIGIN_FACING = "com.amazonaws.global.cloudfront.origin-facing"
HTTPS = 443
# Every IPv4 and every IPv6 address.
WORLD = tuple(map(ipaddress.ip_network, ("0.0.0.0/0", "::/0")))
# The labelled stand-in page synth serves without a web build (infra/site-placeholder).
PLACEHOLDER = re.compile(r"""<meta\s+name=["']desk-site["']\s+content=["']placeholder["']""", re.IGNORECASE)
ASSET_SCRIPT = re.compile(r"""["'](/assets/[^"'?#\s]+\.js)["']""")

HTTP_TIMEOUT = 20.0
ORIGIN_PORTS, ORIGIN_TIMEOUT = (443, 80), 5.0
# The app task's ports: the API's, and the kernel's, which listens on loopback only.
APP_PORTS = (8700, 8701)
TASK_PORTS, TASK_TIMEOUT = APP_PORTS, 3.0
# The API sends a comment every 15 s; CloudFront drops an origin that sends nothing for 60 s.
SSE_HEARTBEATS, SSE_SECONDS, SSE_DEADLINE, SSE_READ_TIMEOUT = 5, 75.0, 105.0, 30.0

SIGNED_IN_CHECKS = ("cookies_first_party", "public_links_use_public_url", "sse_survives_idle")


class CheckFailed(Exception):
    """The check failed; the message says what was seen."""


class Skipped(Exception):
    """The check doesn't apply to this run; the message says why."""


class NotRun(Exception):
    """The check needs DESK_PASSCODE."""


@dataclass
class Response:
    status: int
    headers: Message
    body: bytes

    def header(self, name: str) -> str:
        return self.headers.get(name) or ""

    @property
    def content_type(self) -> str:
        return self.header("Content-Type").split(";", 1)[0].strip().lower()

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self, what: str):
        try:
            return json.loads(self.body)
        except ValueError:
            raise CheckFailed(f"{what} isn't JSON ({self.content_type or 'no content type'})") from None


def parse_cookie(header: str) -> tuple[str, dict[str, str | bool]]:
    """A Set-Cookie header's name and its attributes, names lower-cased (flags map to True)."""
    first, *rest = header.split(";")
    name = first.split("=", 1)[0].strip()
    attributes: dict[str, str | bool] = {}
    for part in rest:
        key, sep, value = part.strip().partition("=")
        if key:
            attributes[key.lower()] = value.strip() if sep else True
    return name, attributes


def cookie_value(header: str) -> str:
    return header.split(";", 1)[0].partition("=")[2].strip()


@dataclass
class Copy:
    """The copy the signed-in checks share: one per run, so a run creates one copy."""

    response: Response
    slugs: list[str]


class Smoke:
    def __init__(self, base_url: str, *, passcode: str | None, origin_host: str | None, cluster: str | None,
                 clients: Mapping | None, load_balancer_arn: str | None = None) -> None:
        parts = urlsplit(base_url)
        self.base_url = f"{parts.scheme}://{parts.netloc}"
        self.https = parts.scheme == "https"
        self.host, self.port = parts.hostname or "", parts.port
        self.passcode = passcode
        self.origin_host = origin_host
        self.load_balancer_arn = load_balancer_arn
        self.cluster = cluster
        self._clients = clients
        self._secrets = {passcode} if passcode else set()
        self._index: Response | None = None
        self._copy: Copy | CheckFailed | None = None
        self._visitors: dict[str, str | CheckFailed] = {}

    # Output -------------------------------------------------------------------------------------

    def redact(self, text: str) -> str:
        for secret in sorted(self._secrets, key=len, reverse=True):
            text = text.replace(secret, "[redacted]")
        return text

    def say(self, line: str) -> None:
        print(self.redact(line), flush=True)

    def remember_cookies(self, response: Response) -> None:
        for header in response.headers.get_all("Set-Cookie") or []:
            value = cookie_value(header)
            if value:
                self._secrets.add(value)

    # HTTP ---------------------------------------------------------------------------------------

    def connection(self, timeout: float) -> http.client.HTTPConnection:
        if self.https:
            return http.client.HTTPSConnection(self.host, self.port, timeout=timeout,
                                               context=ssl.create_default_context())
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def request(self, method: str, path: str, *, headers: Mapping[str, str] | None = None,
                body: dict | None = None) -> Response:
        connection = self.connection(HTTP_TIMEOUT)
        sent = {"User-Agent": "desk-smoke", "Accept": "*/*", **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            sent["Content-Type"] = "application/json"
        try:
            connection.request(method, path, body=data, headers=sent)
            raw = connection.getresponse()
            response = Response(raw.status, raw.headers, raw.read())
        except (OSError, http.client.HTTPException) as error:
            raise CheckFailed(f"{method} {path}: {type(error).__name__}: {error}") from None
        finally:
            connection.close()
        self.remember_cookies(response)
        return response

    def get(self, path: str, **kwargs) -> Response:
        return self.request("GET", path, **kwargs)

    def index(self) -> Response:
        """`/`, fetched once: the web app's HTML or a failure."""
        if self._index is None:
            self._index = self.get(ROUTES["index"])
        response = self._index
        if response.status != 200 or response.content_type != "text/html" or b"<html" not in response.body.lower():
            raise CheckFailed(f"/ answered {response.status} {response.content_type or 'with no content type'}, "
                              "not the web app's HTML")
        return response

    # The signed-in state ------------------------------------------------------------------------

    def copy(self) -> Copy:
        """A new copy made with the passcode, once per run (a failure is remembered too)."""
        if self.passcode is None:
            raise NotRun("DESK_PASSCODE isn't set")
        if self._copy is None:
            try:
                self._copy = self._new_copy()
            except CheckFailed as error:
                self._copy = error
        if isinstance(self._copy, CheckFailed):
            raise self._copy
        return self._copy

    def _new_copy(self) -> Copy:
        path = ROUTES["owner_copies"]
        response = self.request("POST", path, body={"passcode": self.passcode})
        if not 200 <= response.status < 300:
            raise CheckFailed(f"POST {path} answered {response.status}, so no copy was made")
        answer = response.json(f"POST {path}'s answer")
        desks = (answer.get("desks") if isinstance(answer, dict) else None) or []
        slugs = [desk.get("slug") for desk in desks if isinstance(desk, dict) and desk.get("slug")]
        if not slugs:
            raise CheckFailed(f"POST {path} answered a copy with no Desk")
        return Copy(response, slugs)

    def visitor(self, slug: str) -> str:
        """A visitor session's Set-Cookie header on `slug`, opened once per run."""
        if slug not in self._visitors:
            path = ROUTES["visitor_sessions"].format(slug=quote(slug, safe=""))
            try:
                response = self.request("POST", path, body={})
                headers = [h for h in response.headers.get_all("Set-Cookie") or [] if parse_cookie(h)[0] == VISITOR_COOKIE]
                if not 200 <= response.status < 300 or not headers:
                    raise CheckFailed(f"POST {path} answered {response.status} with no {VISITOR_COOKIE} cookie")
                self._visitors[slug] = headers[-1]
            except CheckFailed as error:
                self._visitors[slug] = error
        result = self._visitors[slug]
        if isinstance(result, CheckFailed):
            raise result
        return result

    def clients(self) -> Mapping:
        if self._clients is None:
            import boto3

            self._clients = {name: boto3.client(name, region_name=REGION) for name in ("ecs", "ec2", "elbv2")}
        return self._clients


# Checks ---------------------------------------------------------------------------------------


def index_served(smoke: Smoke) -> str:
    response = smoke.index()
    if PLACEHOLDER.search(response.text):
        raise CheckFailed("/ is the labelled placeholder page: the web build wasn't deployed")
    return f"/ is the web app's HTML ({len(response.body)} bytes)"


def spa_route_served(smoke: Smoke) -> str:
    index, path = smoke.index(), ROUTES["spa_route"]
    response = smoke.get(path)
    if response.status != 200 or response.body != index.body:
        raise CheckFailed(f"{path} answered {response.status} {response.content_type}, not the app's HTML")
    return f"{path} serves the app's HTML"


def assets_served(smoke: Smoke) -> str:
    match = ASSET_SCRIPT.search(smoke.index().text)
    if match is None:
        raise CheckFailed("the app's HTML names no script under /assets/")
    path = match.group(1)
    response = smoke.get(path)
    if response.status != 200:
        raise CheckFailed(f"{path} answered {response.status}")
    if "javascript" not in response.content_type:
        raise CheckFailed(f"{path} is {response.content_type or 'untyped'}, not JavaScript")
    if "immutable" not in response.header("Cache-Control"):
        raise CheckFailed(f"{path} isn't cached immutable (Cache-Control: {response.header('Cache-Control')})")
    return f"{path} is JavaScript, cached immutable"


def api_404_passes_through(smoke: Smoke) -> str:
    path = ROUTES["api_missing"]
    response = smoke.get(path)
    if response.content_type == "text/html":
        raise CheckFailed(f"{path} answered {response.status} with HTML: the app's page is masking API errors")
    if response.status != 404:
        raise CheckFailed(f"{path} answered {response.status}, not the API's 404")
    return f"{path} is the API's 404 ({response.content_type or 'no content type'})"


def api_health(smoke: Smoke) -> str:
    path = ROUTES["api_health"]
    response = smoke.get(path)
    if response.status != 200:
        raise CheckFailed(f"{path} answered {response.status}")
    health = response.json(path)
    kernel = health.get("kernel") if isinstance(health, dict) else None
    if not isinstance(health, dict) or health.get("ok") is not True or not isinstance(kernel, dict):
        raise CheckFailed(f"{path} isn't ok with a kernel")
    problems = []
    if kernel.get("proof_mode") != "symcc":
        problems.append(f"proof_mode is {kernel.get('proof_mode')!r}, not 'symcc'")
    if kernel.get("dev_signing_key") is not False:
        problems.append("the ledger signs with the development key")
    if kernel.get("unproved_seeds") != []:
        problems.append(f"unproved seeds: {kernel.get('unproved_seeds')!r}")
    if problems:
        raise CheckFailed("; ".join(problems))
    return "ok; the kernel proves with SymCC, signs with the production key, every seed proved"


def security_headers(smoke: Smoke) -> str:
    for path in (ROUTES["index"], ROUTES["api_health"]):
        value = smoke.get(path).header("Strict-Transport-Security")
        match = re.search(r"max-age=(\d+)", value)
        if match is None or int(match.group(1)) <= 0:
            raise CheckFailed(f"{path} sends no HSTS header")
    return "HSTS on / and /api/health"


def _connects(host: str, port: int, timeout: float) -> bool:
    """True when a TCP connection opens; refused, unreachable and timed out are all False."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _resolves(host: str) -> None:
    try:
        socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        raise CheckFailed(f"{host} doesn't resolve, so nothing was probed") from None


def _only_tcp(permission: dict, port: int) -> bool:
    """Whether an ingress permission admits TCP on `port` and nothing else."""
    return permission.get("IpProtocol") in ("tcp", "6") and permission.get("FromPort") == port == permission.get(
        "ToPort")


# Where an ingress permission lists its sources, and each source's key, as EC2 names them.
SOURCE_KEYS = (("IpRanges", "CidrIp"), ("Ipv6Ranges", "CidrIpv6"), ("UserIdGroupPairs", "GroupId"),
               ("PrefixListIds", "PrefixListId"))


def _sources(permission: dict) -> list[tuple[str, str]]:
    """Each source of an ingress permission as (kind, value), the kind being EC2's key for it."""
    return [(kind, item.get(kind) or "") for key, kind in SOURCE_KEYS for item in permission.get(key, [])]


@functools.cache
def _express_edge():
    """ExpressEdge's handler module, loaded from its file (a Lambda asset, not a package)."""
    spec = importlib.util.spec_from_file_location("express_edge_index", EXPRESS_EDGE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _traffic(permission: dict) -> str:
    """What an ingress permission admits, as a person reads it: `all traffic`, `port 443` (TCP),
    `udp ports 1000-2000`, `protocol icmp`."""
    protocol = permission.get("IpProtocol")
    if protocol == "-1":
        return "all traffic"
    if protocol not in ("tcp", "6", "udp", "17"):
        return f"protocol {protocol}"
    low, high = permission.get("FromPort"), permission.get("ToPort")
    ports = f"port {low}" if low == high else f"ports {low}-{high}"
    return ports if protocol in ("tcp", "6") else f"udp {ports}"


def _anywhere(values: list[str]) -> bool:
    """Whether these ranges, together, hold every IPv4 or every IPv6 address."""
    networks = []
    for value in values:
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    return any(list(ipaddress.collapse_addresses(n for n in networks if n.version == world.version)) == [world]
               for world in WORLD)


def _admitted_beyond(group: dict, intended: tuple[str, str, int] | None = None) -> list[str]:
    """What a security group admits beyond what the stack intends, one line per ingress rule naming
    the group, the rule's traffic and the sources it shouldn't have.

    A source is intended only when ExpressEdge's lock keeps it on purpose (`kept_source`: another
    group, or a range inside the private ranges, judged as an address range), on any protocol or
    port; or when it is `intended`, a (kind, value, port) source the caller means to admit on TCP
    `port` alone. Anything else fails: a public range, the world however it is written, another
    prefix list, or the intended source on other traffic. Ranges that together hold every address
    read "from anywhere".
    """
    try:
        kept = _express_edge().kept_source
    except Exception as error:
        raise CheckFailed(f"can't read the sources ExpressEdge keeps: {type(error).__name__}: {error}") from None
    problems = []
    for permission in group.get("IpPermissions", []):
        others = [(kind, value) for kind, value in _sources(permission)
                  if not kept(kind, value)
                  and not (intended and (kind, value) == intended[:2] and _only_tcp(permission, intended[2]))]
        if not others:
            continue
        named = ", ".join(value or f"a {kind} with no value" for _, value in others)
        if _anywhere([value for kind, value in others if kind in ("CidrIp", "CidrIpv6")]):
            named = f"anywhere ({named})"
        problems.append(f"{group.get('GroupId')} admits {_traffic(permission)} from {named}")
    return problems


def origin_groups_locked(smoke: Smoke) -> str:
    arn = smoke.load_balancer_arn
    if not arn:
        raise Skipped("no --load-balancer-arn (the fallback's load balancer is internal)")
    clients = smoke.clients()
    elbv2, ec2 = clients["elbv2"], clients["ec2"]
    try:
        balancers = elbv2.describe_load_balancers(LoadBalancerArns=[arn]).get("LoadBalancers", [])
        group_ids = [group for balancer in balancers for group in balancer.get("SecurityGroups") or []]
        if not group_ids:
            raise CheckFailed(f"{arn} has no security groups to check")
        lists = ec2.describe_managed_prefix_lists(
            Filters=[{"Name": "prefix-list-name", "Values": [CLOUDFRONT_ORIGIN_FACING]}]).get("PrefixLists", [])
        if len(lists) != 1:
            raise CheckFailed(f"{len(lists)} prefix lists are named {CLOUDFRONT_ORIGIN_FACING}, not one")
        cloudfront = lists[0].get("PrefixListId")
        groups = ec2.describe_security_groups(GroupIds=group_ids).get("SecurityGroups", [])
    except CheckFailed:
        raise
    except Exception as error:  # botocore's errors, without importing botocore at module load
        raise CheckFailed(f"can't describe the origin's load balancer: {type(error).__name__}: {error}") from None
    if sorted(group.get("GroupId") for group in groups) != sorted(group_ids):
        raise CheckFailed("a security group of the load balancer wasn't found")
    from_cloudfront = ("PrefixListId", cloudfront)
    problems = [problem for group in groups for problem in _admitted_beyond(group, (*from_cloudfront, HTTPS))]
    if not any(_only_tcp(permission, HTTPS) and from_cloudfront in _sources(permission)
               for group in groups for permission in group.get("IpPermissions", [])):
        problems.append(f"no rule admits {HTTPS} from CloudFront's prefix list {cloudfront}")
    if problems:
        raise CheckFailed("; ".join(problems))
    return (f"{', '.join(group_ids)}: CloudFront's prefix list {cloudfront} on {HTTPS}, otherwise only private "
            "sources")


def origin_direct_refused(smoke: Smoke) -> str:
    host = smoke.origin_host
    if not host:
        raise Skipped("no --origin-host (the fallback's load balancer is internal)")
    _resolves(host)
    for port in ORIGIN_PORTS:
        if _connects(host, port, ORIGIN_TIMEOUT):
            raise CheckFailed(f"{host}:{port} took a connection: the origin answers without CloudFront")
    return f"{host} takes no connection on {', '.join(map(str, ORIGIN_PORTS))}"


def _family(task: dict) -> str:
    return task.get("taskDefinitionArn", "").rsplit("/", 1)[-1].rsplit(":", 1)[0]


def task_ports_refused(smoke: Smoke) -> str:
    if not smoke.cluster:
        raise Skipped("no --cluster")
    clients = smoke.clients()
    ecs, ec2 = clients["ecs"], clients["ec2"]
    try:
        arns = ecs.list_tasks(cluster=smoke.cluster, desiredStatus="RUNNING").get("taskArns", [])
        tasks = ecs.describe_tasks(cluster=smoke.cluster, tasks=arns).get("tasks", []) if arns else []
        app = [task for task in tasks if _family(task) == APP_FAMILY]
        if not app:
            raise CheckFailed(f"no running {APP_FAMILY} task in cluster {smoke.cluster} to probe")
        interfaces = {}
        for task in app:
            ids = [detail.get("value") for attachment in task.get("attachments", [])
                   if attachment.get("type") == "ElasticNetworkInterface"
                   for detail in attachment.get("details", []) if detail.get("name") == "networkInterfaceId"]
            if not ids:
                raise CheckFailed(f"task {task.get('taskArn', '?').rsplit('/', 1)[-1]} has no network interface")
            interfaces.update(dict.fromkeys(ids))
        described = ec2.describe_network_interfaces(NetworkInterfaceIds=list(interfaces)).get("NetworkInterfaces", [])
        group_ids = list(dict.fromkeys(group.get("GroupId") for interface in described
                                       for group in interface.get("Groups") or []))
        if not group_ids:
            raise CheckFailed("the task's network interfaces have no security groups to check")
        groups = ec2.describe_security_groups(GroupIds=group_ids).get("SecurityGroups", [])
    except CheckFailed:
        raise
    except Exception as error:  # botocore's errors, without importing botocore at module load
        raise CheckFailed(f"can't describe the task's network: {type(error).__name__}: {error}") from None
    if sorted(group.get("GroupId") for group in groups) != sorted(group_ids):
        raise CheckFailed("a security group of the task wasn't found")
    addresses = []
    for interface in described:
        address = (interface.get("Association") or {}).get("PublicIp")
        if not address:
            raise CheckFailed(f"{interface.get('NetworkInterfaceId')} has no public IP to probe")
        addresses.append(address)
    if len(addresses) < len(interfaces):
        raise CheckFailed("a task's network interface wasn't found")
    problems = [problem for group in groups for problem in _admitted_beyond(group)]
    if problems:
        raise CheckFailed("; ".join(problems))
    for address in addresses:
        for port in TASK_PORTS:
            if _connects(address, port, TASK_TIMEOUT):
                raise CheckFailed(f"{address}:{port} took a connection: the task is reachable without the load balancer")
    return (f"{', '.join(group_ids)}: only private sources; {', '.join(addresses)} takes no connection on "
            f"{', '.join(map(str, TASK_PORTS))}")


def _check_cookie(header: str, *, path: str | None, same_site: str | None) -> list[str]:
    name, attributes = parse_cookie(header)
    problems = [f"{name} has no {flag}" for flag in ("Secure", "HttpOnly") if attributes.get(flag.lower()) is not True]
    if "domain" in attributes:
        problems.append(f"{name} sets Domain={attributes['domain']}")
    if path is not None and attributes.get("path") != path:
        problems.append(f"{name} has Path={attributes.get('path')}, not {path}")
    if same_site is not None and str(attributes.get("samesite", "")).lower() != same_site.lower():
        problems.append(f"{name} has SameSite={attributes.get('samesite')}, not {same_site}")
    return problems


def cookies_first_party(smoke: Smoke) -> str:
    copy = smoke.copy()
    headers = copy.response.headers.get_all("Set-Cookie") or []
    if not any(parse_cookie(header)[0] == OWNER_COOKIE for header in headers):
        raise CheckFailed(f"the new copy set no {OWNER_COOKIE} cookie")
    problems = []
    for header in headers:
        owner = parse_cookie(header)[0] == OWNER_COOKIE
        problems += _check_cookie(header, path=OWNER_COOKIE_PATH if owner else None,
                                  same_site="Strict" if owner else None)
    slug = copy.slugs[0]
    visitor_path = VISITOR_COOKIE_PATH.format(slug=quote(slug, safe=""))
    problems += _check_cookie(smoke.visitor(slug), path=visitor_path, same_site="Strict")
    if problems:
        raise CheckFailed("; ".join(problems))
    return (f"{OWNER_COOKIE}: Secure, HttpOnly, SameSite=Strict, Path={OWNER_COOKIE_PATH}, no Domain; "
            f"{VISITOR_COOKIE}: Secure, HttpOnly, SameSite=Strict, Path={visitor_path}, no Domain")


def public_links_use_public_url(smoke: Smoke) -> str:
    for slug in smoke.copy().slugs:
        path = ROUTES["agent_card"].format(slug=quote(slug, safe=""))
        for headers in ({}, FORGED_HEADERS):
            response = smoke.get(path, headers=headers)
            if response.status != 200:
                raise CheckFailed(f"{path} answered {response.status}")
            card = response.json(path)
            endpoint = card.get("endpoint") if isinstance(card, dict) else None
            if not isinstance(endpoint, str) or not endpoint.startswith(smoke.base_url + "/"):
                forged = f" with {FORGED_HOST} forged" if headers else ""
                raise CheckFailed(f"the agent card's endpoint{forged} is {endpoint!r}, not under {smoke.base_url}")
    return f"agent card endpoints start with {smoke.base_url}, forged hosts ignored"


def sse_survives_idle(smoke: Smoke) -> str:
    slug = smoke.copy().slugs[0]
    cookie = cookie_value(smoke.visitor(slug))
    path = ROUTES["visitor_events"].format(slug=quote(slug, safe=""))
    connection = smoke.connection(SSE_READ_TIMEOUT)
    beats, started = 0, time.monotonic()
    try:
        connection.request("GET", path, headers={"Accept": "text/event-stream", "Cache-Control": "no-cache",
                                                 "Cookie": f"{VISITOR_COOKIE}={cookie}", "User-Agent": "desk-smoke"})
        response = connection.getresponse()
        content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].strip()
        if response.status != 200 or content_type != "text/event-stream":
            raise CheckFailed(f"{path} answered {response.status} {content_type or 'with no content type'}")
        started = time.monotonic()
        while True:
            line = response.readline(65537)
            elapsed = time.monotonic() - started
            if not line:
                raise CheckFailed(f"the stream closed after {elapsed:.1f} s with {beats} heartbeats")
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if text.startswith(":"):
                beats += 1
            elif text.startswith("event:") and text[len("event:"):].strip() == "error":
                raise CheckFailed(f"the stream sent an error event after {elapsed:.1f} s")
            if elapsed > SSE_DEADLINE:
                raise CheckFailed(f"{beats} heartbeats in {elapsed:.0f} s; needs {SSE_HEARTBEATS} over {SSE_SECONDS:g} s "
                                  f"within {SSE_DEADLINE:g} s")
            if beats >= SSE_HEARTBEATS and elapsed >= SSE_SECONDS:
                return f"{beats} heartbeats over {elapsed:.0f} s, no error event"
    except (OSError, http.client.HTTPException) as error:
        elapsed = time.monotonic() - started
        raise CheckFailed(f"the stream failed after {elapsed:.1f} s with {beats} heartbeats: "
                          f"{type(error).__name__}: {error}") from None
    finally:
        connection.close()


CHECKS: dict[str, Callable[[Smoke], str]] = {
    check.__name__: check
    for check in (
        index_served, spa_route_served, assets_served, api_404_passes_through, api_health, security_headers,
        origin_groups_locked, origin_direct_refused, task_ports_refused, cookies_first_party,
        public_links_use_public_url, sse_survives_idle,
    )
}


def _base_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.path not in ("", "/") or parts.query:
        raise argparse.ArgumentTypeError("an http(s) origin with no path, such as https://d111.cloudfront.net")
    return value


def main(argv: list[str] | None = None, *, clients: Mapping | None = None,
         environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smoke-check a deployed Desk.")
    parser.add_argument("--base-url", required=True, type=_base_url, help="the Desk's PublicUrl")
    parser.add_argument("--origin-host", help="Express mode: the service endpoint's host, which must refuse us")
    parser.add_argument("--load-balancer-arn",
                        help="Express mode: the service's load balancer, whose groups must admit CloudFront only")
    parser.add_argument("--cluster", help="the ECS cluster whose app task's public IP must refuse us")
    parser.add_argument("--only", action="append", choices=list(CHECKS), metavar="CHECK",
                        help=f"run only this check (repeatable): {', '.join(CHECKS)}")
    args = parser.parse_args(argv)
    if args.only and "origin_direct_refused" in args.only and not args.origin_host:
        parser.error("origin_direct_refused needs --origin-host")
    if args.only and "task_ports_refused" in args.only and not args.cluster:
        parser.error("task_ports_refused needs --cluster")
    if args.only and "origin_groups_locked" in args.only and not args.load_balancer_arn:
        parser.error("origin_groups_locked needs --load-balancer-arn")

    environ = os.environ if environ is None else environ
    smoke = Smoke(args.base_url, passcode=environ.get("DESK_PASSCODE") or None, origin_host=args.origin_host,
                  cluster=args.cluster, clients=clients, load_balancer_arn=args.load_balancer_arn)
    counts = {"pass": 0, "FAIL": 0, "not run": 0, "skipped": 0}
    for name, check in CHECKS.items():
        if args.only and name not in args.only:
            continue
        try:
            status, detail = "pass", check(smoke)
        except CheckFailed as error:
            status, detail = "FAIL", str(error)
        except NotRun as error:
            status, detail = "not run", str(error)
        except Skipped as error:
            status, detail = "skipped", str(error)
        counts[status] += 1
        smoke.say(f"{status} {name}: {detail}")
    smoke.say(f"smoke: {counts['pass']} passed, {counts['FAIL']} failed, {counts['not run']} not run, "
              f"{counts['skipped']} skipped against {smoke.base_url}")
    if counts["FAIL"]:
        return 1
    return 2 if counts["not run"] else 0


if __name__ == "__main__":
    sys.exit(main())
