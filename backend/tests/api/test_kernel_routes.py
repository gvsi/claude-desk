"""The kernel serves every route the API calls (GitHub issue #100).

The API's tests answer from a fake kernel and the web checks its routes against the API's own OpenAPI document, so
neither notices when the API calls a `KERNEL_ROUTES` key that the kernel doesn't register yet: the contract lists a
route before the kernel plan that adds its handler lands. This test reads the keys the API's code names (an AST scan
of `desk/api/`) and asserts that the kernel app (`desk.kernel_service.app`) registers each one, or that
`PENDING_KERNEL_ROUTES` names the kernel plan that adds it. It also fails when a pending route is registered or isn't
called by the API at all, so the list only shrinks as kernel plans land.

Whichever lands second of this test and a kernel plan's PR (01b, 01c) updates `PENDING_KERNEL_ROUTES`: the later
change takes out the entries the kernel on `main` serves by then.
"""

import ast
import re
from collections.abc import Mapping, Set
from pathlib import Path

from fastapi import FastAPI
from fastapi.routing import iter_route_contexts

import desk.api
from desk.kernel_api import KERNEL_ROUTES
from desk.kernel_service.app import KernelSettings, create_app

# The routes the API calls that the kernel doesn't serve yet, by `KERNEL_ROUTES` key, each with the kernel plan whose
# "Produced" list adds it: 01b, the kernel's verification and owner data plan, and 01c, its payments, agents and setup
# plan. A kernel PR takes out the entries it serves; an API change that calls a route no landed kernel serves adds one.
PENDING_KERNEL_ROUTES: dict[str, str] = {
    "POST /desks": "01b",
    "PUT /desks/{id}/business": "01b",
    "PUT /desks/{id}/charter": "01b",
    "PUT /desks/{id}/hours": "01b",
    "PUT /desks/{id}/prices": "01b",
    "PUT /desks/{id}/calendar": "01b",
    "PUT /desks/{id}/people": "01b",
    "PUT /desks/{id}/notifications": "01b",
    "PUT /desks/{id}/answering": "01b",
    "DELETE /desks/{id}": "01b",
    "POST /documents": "01b",
    "GET /document_links/{token}": "01b",
    "POST /verify/start": "01b",
    "POST /verify/check": "01b",
    "GET /demo_inbox?session_id=": "01b",
    "GET /demo_inbox": "01b",
    "POST /knowledge": "01b",
    "POST /owner/messages": "01b",
    "POST /handoffs/{id}/done": "01b",
    "POST /tools/connect": "01c",
    "POST /tools/simulate_change": "01c",
    "GET /payment_links/{token}": "01c",
    "POST /payment_links/{token}/complete": "01c",
    "POST /payment_links/{token}/cancel": "01c",
    "POST /agents/demo": "01c",
    "POST /policy/{version}/probe": "01c",
}

API = Path(desk.api.__file__).parent
ROUTE_SHAPE = re.compile(r"(?:GET|POST|PUT|PATCH|DELETE) /\S*")
SEGMENT = r"[^/?\s]+"     # what an f-string's formatted value stands for: one path segment


class RouteStrings(ast.NodeVisitor):
    """The `KERNEL_ROUTES` keys a module names: a string that is a key, wherever it sits (a `kernel.call` argument,
    a module constant, a dict's value), and each key an f-string can spell, its formatted values one path segment
    each. The client refuses any route that isn't a key, so every kernel call names one of these ways. A string
    shaped like a route that names no key ("PUT /desks/{id}/" + part) is one the scan can't read, kept in
    `unreadable` by line so the test fails rather than miss the route."""

    def __init__(self, keys: Set[str]):
        self.keys, self.named, self.unreadable = keys, set(), []

    def visit_Set(self, node: ast.Set) -> None:
        """A set of routes says how the client sends them (kernel_client's PROVING_ROUTES), not that the API calls
        them."""

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and ROUTE_SHAPE.fullmatch(node.value):
            self._found({node.value} & self.keys, node)

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        for part in node.values:
            if isinstance(part, ast.FormattedValue):
                self.visit(part)       # an expression inside can name a route too; the literal parts are read below
        head = node.values[0] if node.values else None
        if not (isinstance(head, ast.Constant) and ROUTE_SHAPE.match(head.value)):
            return
        spelled = re.compile("".join(re.escape(part.value) if isinstance(part, ast.Constant) else SEGMENT
                                     for part in node.values))
        self._found({key for key in self.keys if spelled.fullmatch(key)}, node)

    def _found(self, keys: set[str], node: ast.expr) -> None:
        if not keys:
            self.unreadable.append(f"line {node.lineno}: {ast.unparse(node)}")
        self.named |= keys


def routes_named(source: str, keys: Set[str]) -> tuple[set[str], list[str]]:
    """The keys of `keys` a module's source names, and the route-shaped strings in it that name none."""
    scan = RouteStrings(keys)
    scan.visit(ast.parse(source))
    return scan.named, scan.unreadable


def api_routes() -> tuple[set[str], list[str]]:
    """The `KERNEL_ROUTES` keys the API's code names, and the route-shaped strings in it that name none."""
    called, unreadable = set(), []
    for path in sorted(API.rglob("*.py")):
        named, lines = routes_named(path.read_text(), frozenset(KERNEL_ROUTES))
        called |= named
        unreadable += [f"{path.relative_to(API)} {line}" for line in lines]
    return called, unreadable


def template(path: str) -> str:
    """A path with its parameters' names (and converters) left out: `/desks/{desk_id}` and `/desks/{id}` agree."""
    return re.sub(r"\{[^}]*\}", "{}", path)


def served_routes(app: FastAPI) -> set[str]:
    """The `KERNEL_ROUTES` keys the kernel app serves. For each key, the client's request (its method and path, the
    parameters filled in and the query that tells some keys apart left out) goes to the first route the router would
    run for it, a route with no methods (a mount) taking any; that route serves the key only when its template is the
    key's, so a parameter route or a catch-all ahead of it doesn't stand in for it."""
    routes = list(iter_route_contexts(app.routes))
    served = set()
    for key in KERNEL_ROUTES:
        method, _, target = key.partition(" ")
        key_template = target.partition("?")[0]
        path = re.sub(r"\{\w+\}", "p-1", key_template)
        runs = next((route for route in routes
                     if (route.methods is None or method in route.methods) and route.path_regex.match(path)), None)
        if runs is not None and template(runs.path) == template(key_template):
            served.add(key)
    return served


def seam_problems(called: Set[str], served: Set[str], pending: Mapping[str, str]) -> list[str]:
    """What breaks the seam, one line per route, by `KERNEL_ROUTES` key: a route the API calls that the kernel
    doesn't serve and no pending entry names, or a pending route the API doesn't call or the kernel serves now. Empty
    when the seam holds."""
    problems = []
    for key in sorted(called | set(pending)):
        if key in pending:
            if key not in called:
                problems.append(f"{key} is pending ({pending[key]}) but the API doesn't call it: take it out of "
                                "PENDING_KERNEL_ROUTES")
            elif key in served:
                problems.append(f"{key} is pending ({pending[key]}) but the kernel serves it now: take it out of "
                                "PENDING_KERNEL_ROUTES")
        elif key not in served:
            problems.append(f"the API calls {key}, which the kernel doesn't serve: serve it, or list it in "
                            "PENDING_KERNEL_ROUTES with the kernel plan that adds it")
    return problems


def test_the_kernel_serves_every_route_the_api_calls():
    called, unreadable = api_routes()
    assert unreadable == []
    # the scan reads the client's own call, both Demo inbox forms and the proxy's route constants
    assert {"GET /whoami", "GET /demo_inbox?session_id=", "GET /demo_inbox", "GET /payment_links/{token}",
            "GET /document_links/{token}"} <= called
    kernel = create_app(KernelSettings(database_url="postgresql+asyncpg://unused/unused"))
    assert seam_problems(called, served_routes(kernel), PENDING_KERNEL_ROUTES) == []


def test_an_unlisted_route_the_kernel_doesnt_serve_fails_with_its_name():
    problems = seam_problems(called={"GET /health", "GET /demo_inbox"}, served={"GET /health"}, pending={})
    assert problems == ["the API calls GET /demo_inbox, which the kernel doesn't serve: serve it, or list it in "
                        "PENDING_KERNEL_ROUTES with the kernel plan that adds it"]


def test_a_pending_route_the_kernel_now_serves_fails():
    problems = seam_problems(called={"GET /demo_inbox"}, served={"GET /demo_inbox"}, pending={"GET /demo_inbox": "01b"})
    assert problems == ["GET /demo_inbox is pending (01b) but the kernel serves it now: take it out of "
                        "PENDING_KERNEL_ROUTES"]


def test_a_pending_route_the_api_doesnt_call_fails():
    problems = seam_problems(called={"GET /health"}, served={"GET /health"}, pending={"POST /tools/confirm": "01c"})
    assert problems == ["POST /tools/confirm is pending (01c) but the API doesn't call it: take it out of "
                        "PENDING_KERNEL_ROUTES"]


SCAN_KEYS = frozenset({"GET /health", "GET /whoami", "GET /demo_inbox", "GET /demo_inbox?session_id=",
                       "PUT /desks/{id}/hours", "PUT /desks/{id}/prices", "GET /payment_links/{token}",
                       "POST /payment_links/{token}/complete", "POST /tools/confirm"})


def test_the_scan_reads_each_way_the_api_names_a_route():
    source = '''
LINK_ROUTE = "GET /payment_links/{token}"
STEPS = {"complete": "POST /payment_links/{token}/complete"}
PROVING_ROUTES = frozenset({"POST /tools/confirm"})

async def read(kernel, part):
    """GET /health, named in a docstring, isn't a call."""
    log.info("GET /whoami %s", part)
    await kernel.call("GET /demo_inbox?session_id=", query={"session_id": "s1"})
    await kernel.call("GET /demo_inbox")
    await kernel.call(f"PUT /desks/{{id}}/{part}", path={"id": "d1"})
'''
    assert routes_named(source, SCAN_KEYS) == ({
        "GET /payment_links/{token}", "POST /payment_links/{token}/complete",     # through a constant and a dict
        "GET /demo_inbox?session_id=", "GET /demo_inbox",                         # told apart by their query
        "PUT /desks/{id}/hours", "PUT /desks/{id}/prices",                        # every part the f-string can name
    }, [])


def test_the_scan_reports_a_route_it_cant_read():
    source = '''
async def read(kernel, part, query):
    await kernel.call("PUT /desks/{id}/" + part, path={"id": "d1"})
    await kernel.call(f"GET /demo_inbox{query}")
    await kernel.call("GET /demo-inbox")
'''
    assert routes_named(source, SCAN_KEYS) == (set(), [
        "line 3: 'PUT /desks/{id}/'", "line 4: f'GET /demo_inbox{query}'", "line 5: 'GET /demo-inbox'"])


def test_a_route_is_served_when_the_kernel_runs_its_method_and_path():
    kernel = FastAPI()
    kernel.get("/demo_inbox")(lambda: [])
    kernel.get("/ledger/{desk_id}")(lambda desk_id: {})
    kernel.delete("/desks/{desk_id}")(lambda desk_id: None)    # its own name for the key's {id}
    kernel.get("/verify/start")(lambda: None)                  # the key is a POST
    assert served_routes(kernel) == {"GET /demo_inbox?session_id=", "GET /demo_inbox",
                                     "GET /ledger/{desk_id}?verify=true", "DELETE /desks/{id}"}


BY_CALL = "GET /decisions/by_call?session_id=&generation=&call_id="


def test_a_parameter_route_doesnt_serve_a_key_with_a_fixed_segment():
    kernel = FastAPI()
    kernel.get("/decisions/{decision_id}")(lambda decision_id: {})
    assert served_routes(kernel) == {"GET /decisions/{id}"}


def test_a_key_is_served_by_the_first_route_the_router_runs():
    kernel = FastAPI()
    kernel.get("/decisions/{decision_id}")(lambda decision_id: {})     # declared first, it takes /decisions/by_call
    kernel.get("/decisions/by_call")(lambda: {})
    assert served_routes(kernel) == {"GET /decisions/{id}"}

    kernel = FastAPI()
    kernel.get("/decisions/by_call")(lambda: {})
    kernel.get("/decisions/{decision_id}")(lambda decision_id: {})
    assert served_routes(kernel) == {BY_CALL, "GET /decisions/{id}"}


def test_a_catch_all_serves_nothing_it_isnt():
    kernel = FastAPI()
    kernel.api_route("/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"])(lambda rest: {})
    assert served_routes(kernel) == set()

    kernel, inner = FastAPI(), FastAPI()
    inner.get("/demo_inbox")(lambda: [])
    kernel.mount("/", inner)                                           # a mount ahead of a route takes its requests
    kernel.get("/demo_inbox")(lambda: [])
    assert served_routes(kernel) == set()
