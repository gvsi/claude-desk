"""The API routes the evals drive, by operation name (Plan 02a's and 02b's paths).

Each entry names the `landed.toml` id whose PR lands it: `02a` for the public chat, the owner
reads and the health check (Plan 02a's Task 9 adds `02a`), `02` for verification, the Demo inbox,
document links, A2A and take-over (Plan 02b's Task 12 adds `02`). Tier 1 checks every landed entry
against the API's OpenAPI document, so a renamed path fails a case instead of turning into a 404
the case reads as "nothing there". Plan 05b adds the owner and agent operations tier 2 needs: the
owner's answer, Demo inbox and Answering switch with Plan 02a, the rest with Plan 02b.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import quote

_PARAM = re.compile(r"{(\w+)}")


@dataclass(frozen=True)
class ApiRoute:
    method: str
    path: str                                             # a template: `{name}` parameters
    plan: str                                             # the landed.toml id that lands it: "02a" or "02"
    query: dict[str, str] = field(default_factory=dict)   # fixed query parameters

    @property
    def params(self) -> tuple[str, ...]:
        return tuple(_PARAM.findall(self.path))

    @property
    def operation(self) -> tuple[str, str]:
        """The method and path as an OpenAPI document keys them, parameter names left out."""
        return self.method.lower(), _PARAM.sub("{}", self.path)

    def url(self, **params: object) -> str:
        """The path with each parameter filled in, percent-encoded; a missing or extra one raises."""
        if set(params) != set(self.params):
            raise ValueError(f"{self.method} {self.path} takes {list(self.params)}, not {sorted(params)}")
        return _PARAM.sub(lambda m: quote(str(params[m.group(1)]), safe=""), self.path)


_CHAT = "/api/public/desks/{desk_slug}"
_OWNER = "/api/owner"

ROUTES: dict[str, ApiRoute] = {
    # Plan 02a (its Tasks 3, 7 and 9): the public chat, the owner's reads, the health check
    "health": ApiRoute("GET", "/api/health", "02a"),
    "enter": ApiRoute("POST", f"{_OWNER}/copies", "02a"),                  # {passcode} -> CopyOut, the owner cookie
    "open_chat": ApiRoute("POST", f"{_CHAT}/sessions", "02a"),             # -> VisitorSession, the visitor cookie
    "chat_session": ApiRoute("GET", f"{_CHAT}/session", "02a"),            # -> VisitorTranscript
    "send": ApiRoute("POST", f"{_CHAT}/messages", "02a"),                  # {text} -> 202 MessageAccepted
    "events": ApiRoute("GET", f"{_CHAT}/events", "02a"),                   # SSE, `id:` = seq, Last-Event-ID
    "owner_session": ApiRoute("GET", f"{_OWNER}/conversations/{{session_id}}", "02a"),   # -> OwnerTranscript
    "owner_decision": ApiRoute("GET", f"{_OWNER}/decisions/{{decision_id}}", "02a"),     # -> Decision
    "owner_ledger": ApiRoute("GET", f"{_OWNER}/desks/{{desk_id}}/ledger", "02a", {"verify": "true"}),  # LedgerPage
    # Plan 02b (its Tasks 1-4): verification, the Demo inbox, document links, A2A, take-over
    "verify_start": ApiRoute("POST", f"{_CHAT}/verify/start", "02"),       # {contact} -> VerifyStarted
    "verify_check": ApiRoute("POST", f"{_CHAT}/verify/check", "02"),       # {code} -> VerifyChecked
    "my_demo_inbox": ApiRoute("GET", f"{_CHAT}/demo_inbox", "02"),         # -> [DemoInboxEntry]
    "fetch_document": ApiRoute("GET", "/api/d/{token}", "02"),             # a document_link card's href
    "a2a": ApiRoute("POST", "/api/a2a/{desk_slug}", "02"),                 # A2ARequest, signed -> A2AResponse
    "owner_take_over": ApiRoute("POST", f"{_OWNER}/conversations/{{session_id}}/takeover", "02"),  # {generation}
    # Plan 05b: what a tier 2 run's simulated owner and visiting agent do. Plan 02a's Tasks 8 and 9
    "owner_answer": ApiRoute("POST", f"{_OWNER}/approvals/{{decision_id}}/answer", "02a"),   # {answer}
    "owner_demo_inbox": ApiRoute("GET", f"{_OWNER}/demo_inbox", "02a"),                       # -> [DemoInboxEntry]
    "owner_set_answering": ApiRoute("PUT", f"{_OWNER}/desks/{{desk_id}}/answering", "02a"),   # {on} -> DeskUpdated
    # and Plan 02b's Tasks 1, 3, 4, 5 and 9
    "owner_whisper": ApiRoute("POST", f"{_OWNER}/conversations/{{session_id}}/messages", "02"),   # {text, kind}
    "owner_add_document": ApiRoute("POST", f"{_OWNER}/desks/{{desk_id}}/documents", "02"),       # {document}
    "owner_add_knowledge": ApiRoute("POST", f"{_OWNER}/desks/{{desk_id}}/knowledge", "02"),      # {item}
    "owner_simulate_tool_change": ApiRoute("POST", f"{_OWNER}/desks/{{desk_id}}/tools/simulate_change", "02"),  # {tool}
    "complete_payment_link": ApiRoute("POST", "/api/pay/{token}/complete", "02"),             # {} -> link state
    "agent_demo": ApiRoute("POST", f"{_CHAT}/agents/key", "02"),                              # -> DemoAgentIssued, once
}

__all__ = ["ROUTES", "ApiRoute"]
