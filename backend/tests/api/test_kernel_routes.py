"""The kernel serves every route the API calls (GitHub issue #100).

The API's tests answer from a fake kernel and the web checks its routes against the API's own OpenAPI document, so
neither notices when the API calls a `KERNEL_ROUTES` key that the kernel doesn't register yet: the contract lists a
route before the kernel plan that adds its handler lands. This test reads the route each kernel call in `desk/api/`
passes (an AST scan of its `.call(...)` and `.stream(...)` sites, where a route it can't read fails the test) and
asserts that the kernel app (`desk.kernel_service.app`) registers each one, or that `PENDING_KERNEL_ROUTES` names the
kernel plan that adds it. It also fails when a pending route is registered or isn't called by the API at all, so the
list only shrinks as kernel plans land.

What it can't see is a route's branches: it checks that the kernel registers a route, not that the route takes every
request the API sends it. As this test lands, the kernel on `main` refuses the agent branch of `POST /sessions` and of
`GET /whoami?session_id=`, which plan 01c adds, and the preview branch of `POST /sessions`, which plan 01b adds
(`desk/kernel_service/sessions.py`).

Whichever lands second of this test and a kernel plan's PR (01b, 01c) updates `PENDING_KERNEL_ROUTES`: the later
change takes out the entries the kernel on `main` serves by then.
"""

import ast
import re
from collections import Counter
from collections.abc import Mapping, Set
from pathlib import Path

from fastapi import FastAPI
from fastapi.routing import iter_route_contexts

import desk.api
from desk.api.kernel_client import PROVING_ROUTES, SET_FIELDS_ONLY, STREAM_ROUTES
from desk.kernel_api import KERNEL_ROUTES
from desk.kernel_service.app import KernelSettings, create_app
from tests.kernel.test_app import LATER_ROUTES

# The routes the API calls that the kernel doesn't serve yet, by `KERNEL_ROUTES` key, each with the kernel plan whose
# "Produced" list adds it: 01b, the kernel's verification and owner data plan, and 01c, its payments, agents and setup
# plan. A kernel PR takes out the entries it serves; an API change that calls a route no landed kernel serves adds one.
PENDING_KERNEL_ROUTES: dict[str, str] = {}

API = Path(desk.api.__file__).parent
SEGMENT = r"[^/?\s]+"     # what an f-string's formatted value stands for: one path segment
# Receivers whose `.call` or `.stream` isn't a kernel view's: the model client and the Anthropic client inside it
# (desk.api.model), a Starlette request (`request.stream()`, desk.api.a2a), and the proving runner, which streams Ask
# Claude's answer (`state.proving.stream(...)`, desk.api.routes.setup).
NOT_KERNEL_VIEWS = frozenset({"model", "self.model", "self._client.beta.messages", "self._client.messages", "request",
                              "state.proving"})


def bindings(tree: ast.AST) -> Counter[str]:
    """How many times each name is bound anywhere in `tree`, in any scope: an assignment, loop, `with`, comprehension
    or walrus target, a parameter, an import, a def or class, an `except` name, a match capture, or a `global` or
    `nonlocal` declaration."""
    bound: Counter[str] = Counter()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound[node.id] += 1
        elif isinstance(node, ast.arg):
            bound[node.arg] += 1
        elif isinstance(node, ast.alias):
            bound[(node.asname or node.name).partition(".")[0]] += 1
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound[node.name] += 1
        elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
            bound[node.name] += 1
        elif isinstance(node, ast.MatchMapping) and node.rest:
            bound[node.rest] += 1
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            bound.update(node.names)
    return bound


def wildcard_imports(tree: ast.AST) -> list[ast.ImportFrom]:
    """Each `from x import *` in `tree`."""
    return [node for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and any(alias.name == "*" for alias in node.names)]


def module_constants(tree: ast.Module) -> dict[str, ast.expr]:
    """The names a module binds exactly once, by an assignment at its top level, with the expression each holds. A
    name bound anywhere else too (a parameter, a local, a loop or `with` target, a comprehension variable) isn't one,
    so a call that passes it is unreadable instead of read as the module's value. A module with a wildcard import has
    none, since the import can rebind any name."""
    if wildcard_imports(tree):
        return {}
    bound = bindings(tree)
    constants = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        for target in targets:
            if isinstance(target, ast.Name) and bound[target.id] == 1:
                constants[target.id] = value
    return constants


def route_keys(node: ast.expr, constants: Mapping[str, ast.expr], keys: Set[str]) -> set[str]:
    """The keys a kernel call's route argument names: a string that is one, each key an f-string can spell (its
    formatted values one path segment each), or a module constant that holds one, or a dict whose values all are
    (`STEPS[step]`). Empty when it names none or can't be read."""
    if isinstance(node, ast.Constant):
        return {node.value} & keys if isinstance(node.value, str) else set()
    if isinstance(node, ast.JoinedStr):
        spelled = re.compile("".join(re.escape(part.value) if isinstance(part, ast.Constant) else SEGMENT
                                     for part in node.values))
        return {key for key in keys if spelled.fullmatch(key)}
    if isinstance(node, ast.Name) and node.id in constants:
        return route_keys(constants[node.id], {}, keys)
    if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name)
            and isinstance(constants.get(node.value.id), ast.Dict)):
        named = [route_keys(value, {}, keys) for value in constants[node.value.id].values]
        return set().union(*named) if named and all(named) else set()
    return set()


def route_argument(call: ast.Call) -> ast.expr | None:
    """The route a kernel view's `.call(route, ...)` or `.stream(route, ...)` passes, by position or as `route=`, or
    the call itself when it passes neither (no arguments, only other keywords, or `**mapping`), which the scan can't
    read. None for a call that isn't one: another method, or a receiver in NOT_KERNEL_VIEWS."""
    func = call.func
    if (not isinstance(func, ast.Attribute) or func.attr not in ("call", "stream")
            or ast.unparse(func.value) in NOT_KERNEL_VIEWS):
        return None
    if call.args:
        return call.args[0]
    return next((keyword.value for keyword in call.keywords if keyword.arg == "route"), call)


def routes_called(source: str, keys: Set[str]) -> tuple[set[str], list[str]]:
    """The keys of `keys` a module's kernel calls name, and by line each call whose route the scan can't read, and
    each wildcard import, which can rebind a route constant. Every `.call(...)` and `.stream(...)` on a receiver not
    in NOT_KERNEL_VIEWS is taken for a kernel view's, so a call the scan can't read fails the test instead of going
    unchecked. A route named anywhere else (an error's text, the client's route sets) isn't a call."""
    tree = ast.parse(source)
    constants = module_constants(tree)
    called = set()
    unreadable = [(node.lineno, f"line {node.lineno}: {ast.unparse(node)}") for node in wildcard_imports(tree)]
    for node in ast.walk(tree):
        route = route_argument(node) if isinstance(node, ast.Call) else None
        if route is None:
            continue
        named = route_keys(route, constants, keys)
        if not named:
            unreadable.append((node.lineno, f"line {node.lineno}: {ast.unparse(route)}"))
        called |= named
    return called, [line for _, line in sorted(unreadable)]


def api_routes() -> tuple[set[str], list[str]]:
    """The `KERNEL_ROUTES` keys the API's kernel calls name, and the calls whose route the scan can't read."""
    called, unreadable = set(), []
    for path in sorted(API.rglob("*.py")):
        named, lines = routes_called(path.read_text(), frozenset(KERNEL_ROUTES))
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


def tag_problems(pending: Mapping[str, str], later: Mapping[str, Set[str]]) -> list[str]:
    """Each pending route whose plan isn't the one the kernel's own list of routes its later plans serve
    (`LATER_ROUTES` in tests/kernel/test_app.py) gives it."""
    plan_of = {key: plan for plan, keys in later.items() for key in keys}
    problems = []
    for key, plan in sorted(pending.items()):
        if key not in plan_of:
            problems.append(f"{key} is pending ({plan}) but the kernel's LATER_ROUTES doesn't list it")
        elif plan_of[key] != plan:
            problems.append(f"{key} is pending ({plan}) but the kernel's LATER_ROUTES has it in {plan_of[key]}")
    return problems


def test_the_kernel_serves_every_route_the_api_calls():
    called, unreadable = api_routes()
    assert unreadable == []
    # the scan reads the client's own call, both Demo inbox forms and the proxy's route constants
    assert {"GET /whoami", "GET /demo_inbox?session_id=", "GET /demo_inbox", "GET /payment_links/{token}",
            "GET /document_links/{token}"} <= called
    kernel = create_app(KernelSettings(database_url="postgresql+asyncpg://unused/unused"))
    assert seam_problems(called, served_routes(kernel), PENDING_KERNEL_ROUTES) == []
    assert tag_problems(PENDING_KERNEL_ROUTES, LATER_ROUTES) == []


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
                       "POST /payment_links/{token}/complete", "POST /payment_links/{token}/cancel",
                       "GET /document_links/{token}", "POST /tools/confirm"})


def test_the_scan_reads_each_kernel_call_site():
    source = '''
LINK_ROUTE = "GET /payment_links/{token}"
STEPS = {"complete": "POST /payment_links/{token}/complete", "cancel": "POST /payment_links/{token}/cancel"}
PROVING_ROUTES = frozenset({"POST /tools/confirm"})

async def read(kernel, view, model, request, part, step):
    await kernel.call("GET /demo_inbox?session_id=", query={"session_id": "s1"})
    await kernel.call("GET /demo_inbox")
    await kernel.call(f"PUT /desks/{{id}}/{part}", path={"id": "d1"})
    await kernel.public().call(LINK_ROUTE, path={"token": "t1"})
    await view.call(STEPS[step], path={"token": "t1"})
    await view.call(route="GET /whoami")
    async with kernel.stream("GET /document_links/{token}", {"token": "t1"}):
        pass
    await model.call(request)
    raise KernelUnavailable("GET /health")
'''
    assert routes_called(source, SCAN_KEYS) == ({
        "GET /demo_inbox?session_id=", "GET /demo_inbox",                         # told apart by their query
        "PUT /desks/{id}/hours", "PUT /desks/{id}/prices",                        # every part the f-string can name
        "GET /payment_links/{token}",                                             # a module constant
        "POST /payment_links/{token}/complete", "POST /payment_links/{token}/cancel",   # each value of a dict
        "GET /whoami", "GET /document_links/{token}",                             # by keyword; a stream
    }, [])   # not the model client's call, a route in an error or a set of routes


def test_the_scan_reports_a_call_it_cant_read():
    source = '''
TIMEOUT = 6.0

async def read(kernel, path, routes):
    await kernel.call("GET " + path)
    await kernel.call(f"GET {path}")
    for route in {"GET /demo_inbox", "GET /whoami"}:
        await kernel.call(route)
    await kernel.call("GET /demo-inbox")
    await kernel.call(TIMEOUT)
    await kernel.call(*routes)
'''
    assert routes_called(source, SCAN_KEYS) == (set(), [
        "line 5: 'GET ' + path", "line 6: f'GET {path}'", "line 8: route", "line 9: 'GET /demo-inbox'",
        "line 10: TIMEOUT", "line 11: *routes"])


def test_the_clients_route_sets_name_only_kernel_routes():
    # how the client sends a route (a proving deadline, a byte stream, set fields only), not calls of it
    assert sorted((PROVING_ROUTES | STREAM_ROUTES | SET_FIELDS_ONLY) - set(KERNEL_ROUTES)) == []


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


def test_a_pending_route_tagged_with_another_plan_than_the_kernels_fails():
    later = {"01b": {"GET /demo_inbox"}, "01c": {"POST /agents/demo"}}
    assert tag_problems({"GET /demo_inbox": "01b", "POST /agents/demo": "01b"}, later) == [
        "POST /agents/demo is pending (01b) but the kernel's LATER_ROUTES has it in 01c"]
    assert tag_problems({"POST /handoffs/{id}/done": "01b"}, later) == [
        "POST /handoffs/{id}/done is pending (01b) but the kernel's LATER_ROUTES doesn't list it"]


def test_a_kernel_call_with_no_route_argument_is_unreadable():
    source = '''
async def read(kernel, request, route, kwargs):
    await kernel.call(**{"route": route})
    async with kernel.stream(**kwargs):
        pass
    await kernel.call(path={"id": "d1"})
    await kernel.call()
    async for chunk in request.stream():
        pass
'''
    assert routes_called(source, SCAN_KEYS) == (set(), [   # Starlette's request.stream() is in NOT_KERNEL_VIEWS
        "line 3: kernel.call(**{'route': route})", "line 4: kernel.stream(**kwargs)",
        "line 6: kernel.call(path={'id': 'd1'})", "line 7: kernel.call()"])


REBINDINGS = {
    "a parameter": "async def read(kernel, ROUTE):\n    await kernel.call(ROUTE)\n",
    "an assignment": "async def read(kernel):\n    ROUTE = 'GET /whoami'\n    await kernel.call(ROUTE)\n",
    "a loop target": "async def read(kernel, routes):\n    for ROUTE in routes:\n        await kernel.call(ROUTE)\n",
    "a with target": "async def read(kernel, opened):\n    with opened() as ROUTE:\n        await kernel.call(ROUTE)\n",
    "a comprehension variable": "def read(kernel, routes):\n    return [kernel.call(ROUTE) for ROUTE in routes]\n",
    "a parameter, for a dict": "async def read(kernel, STEPS, step):\n    await kernel.call(STEPS[step])\n",
}


def test_a_module_constant_that_an_enclosing_scope_rebinds_is_unreadable():
    constants = 'ROUTE = "GET /health"\nSTEPS = {"complete": "POST /payment_links/{token}/complete"}\n\n'
    for binding, function in REBINDINGS.items():
        called, unreadable = routes_called(constants + function, SCAN_KEYS)
        assert (called, [line.partition(": ")[2] for line in unreadable]) == (
            set(), ["STEPS[step]" if "STEPS" in function else "ROUTE"]), binding


def test_a_wildcard_import_is_unreadable():
    source = '''
ROUTE = "GET /health"
from desk.api.routes.proxy import *

async def read(kernel):
    await kernel.call(ROUTE)
'''
    assert routes_called(source, SCAN_KEYS) == (set(), [   # it can rebind any name, so no name is a constant
        "line 3: from desk.api.routes.proxy import *", "line 6: ROUTE"])
