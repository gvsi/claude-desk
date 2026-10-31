"""The turn's language (`POST /sessions/{session_id}/turn`): what a turn's receipts and cards read in.

The API calls it once at turn start, before `/context`, with the newest visitor or agent message, at
most 2,000 characters (more is 422 `invalid`, refused before anything is read, and nothing is cut).
The message is untrusted text, read for one thing: its language, by `lang.detect` on the text as the
reply check reads Claude's prose (`reply_check.shown`). English or Spanish becomes the session's
language (`last_language`); another language, or too little to tell, keeps the one it had. The
answer is the session's language after the call.

Everything rendered later in the turn reads it: a decision's status line and an executed action's
receipt (`decide.status_line`), the verification messages, and the reply check's fallback when
Claude's prose is too short to detect (`reply_check.check_draft`); at the turn's end the reply check
keeps it or changes it by the language of Claude's prose (`reply_check.finalize`). So a Spanish turn
after an English one reads Spanish from its first receipt, where it read the previous turn's
language until Claude's first reply.

The message is never stored, logged or ledgered, and the call writes nothing else: no other column
of the session (not the time it was last seen, which the turn's next call writes), no ledger entry,
no row. A repeat call detects again and changes nothing more.

It answers "Session state responses" as `/context` does, and checks a generation too: the session's
own token, or the owner's for its own session and a Desk of its copy (`desk_id`, which the owner
must name, else 422 `invalid`); a bad token is 401, another copy or Desk 404, a closed session or a
deleted Desk 409 `closed`, a stale generation 409 `stale_generation`, each ledgered `auth` on the
Desk of the session it names (logged when it names none). A session the owner took over or the
breaker paused still starts its turn. The session row is held `FOR UPDATE` from the generation check
to the commit (`auth.lock_session`, the first step of `repo.py`'s lock order), so a take-over comes
before the call (409) or after the language is written, never between.
"""

from fastapi import APIRouter, Request

from desk.kernel_api import TurnRequest, TurnStarted
from desk.kernel_service import auth, lang, render
from desk.kernel_service.repo import Ctx
from desk.kernel_service.reply_check import shown

router = APIRouter()


@router.post("/sessions/{session_id}/turn", response_model=TurnStarted)
async def start_turn(session_id: str, body: TurnRequest, ctx: Ctx, request: Request) -> TurnStarted:
    named = await auth.authenticate_caller(ctx, request, session_id, body.desk_id)
    row, _ = await auth.check_caller(ctx, request, named, generation=body.generation, lock=True, seen=False)
    detected = lang.detect(shown(body.text))
    if detected in ("en", "es"):
        row.last_language = detected
    return TurnStarted(language=render.language(row.last_language))
