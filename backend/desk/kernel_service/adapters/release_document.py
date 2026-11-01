"""`native.release_document`: one of the Desk's documents, shared with the verified person it belongs to.

The call names a document by its ID, bare or as its fact ID (`document:<id>`, as Claude's context
shows it: `base.fact_ref`). `normalize` resolves it from `documents`: it must be this Desk's, else
the call is refused at step 1; the resource is the row's own ID and its owner the document's record
owner, read from the row, never from args, and everything after `normalize` names the document by
`action.resource.id`. Who may have it is Cedar's: the baseline lets private data go
only to a verified principal who is the record owner.

`execute` writes a `document_links` row whose token (`secrets.token_urlsafe(32)`) opens the
document once within `LINK_TTL`, beside the token's sha256 (`token_sha256`, hashed as a session's
token is), the one thing the copy resolver may read, and a `document_link:<link_id>` fact holding
the title and the link's ID, readable only by the readers the document and the session share (the
owner and the record owner), so any session verified as the record owner may cite it and no other.
Claude is told only that the link is ready; the token stays in its row, never in a fact,
`model_view`, a ledger summary or a log line. The release is ledgered `document_link` `{link_id,
document_id, issued}`.

A link opens once (`open_document_link`, `GET /document_links/{token}`, which the API proxies at
`/api/d/{token}`): one UPDATE marks it opened if it is unopened, not voided and unexpired, and its
document is still its person's on a Desk not deleted, and its fact expires in the same
transaction, so a later citation is `stale_fact`. The document goes out as plain text under a file
name made from its fact's title (`download_name`). Anything else (opened, expired, voided, unknown)
is the same 404. Deleting the Desk or removing its person voids the link (`void_links`), and its
fact expires too (`expire_link_facts`).
"""

import re
import secrets
import unicodedata
from collections.abc import Sequence
from datetime import datetime, timedelta
from functools import partial
from typing import Any, NamedTuple

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from sqlalchemy.sql import ColumnElement

from desk.contracts import Claim, Fact, LedgerEvent, NormalizedAction, ResourceRef, ToolProfile
from desk.db.models import Desk, Document, DocumentLink
from desk.db.models import Fact as FactRow
from desk.kernel_service import auth, labels, ledger, render, repo
from desk.kernel_service.adapters import register
from desk.kernel_service.adapters.base import (AdapterFailure, AdapterRefusal, AdapterResult, ExecCtx, Normalized,
                                               NormalizeCtx, fact_ref)
from desk.kernel_service.repo import KernelCtx, KernelFailure, new_id

LINK_TTL = timedelta(hours=24)
FACT_PREFIX = "document_link:"
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")          # secrets.token_urlsafe(32)
MEDIA_TYPE = "text/plain; charset=utf-8"
DOWNLOAD_STEM_CHARS = 60                          # a file name's length before `.txt`


def token_sha256(token: str) -> str:
    """What a link is looked up by before its copy is known (`repo.copy_of_document_link`): the
    token's sha256, as a session's token is stored (`auth.hash_token`)."""
    return auth.hash_token(token)


class ReleaseDocumentArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    document_id: str = Field(max_length=64)


PROFILE = ToolProfile(
    tool="native.release_document", source="native", effects=["private_data", "send_message"], reversible=False,
    adapter="desk.kernel_service.adapters.release_document", resource_kind="document",
    description_confirmed=(
        "Shares one of the business's records, such as an invoice or a warranty, with the verified customer it "
        "belongs to, by the document_id in your context. They get a link that opens once, in a card; never "
        "repeat what the document says in your own words."),
    input_schema=ReleaseDocumentArgs.model_json_schema(), status="enabled")


async def find_document(ctx: KernelCtx, desk_id: str, document_id: str) -> Document | None:
    """The Desk's document `document_id`, in the bound copy."""
    if not repo.storable(document_id):
        return None
    return (await ctx.db.scalars(ctx.repo.scoped(select(Document).where(
        Document.desk_id == desk_id, Document.document_id == document_id)))).one_or_none()


async def _document_fact(ctx: KernelCtx, desk_id: str, document_id: str) -> FactRow | None:
    return (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.fact_id == f"document:{document_id}")))).one_or_none()


def model_view(fact: Fact) -> dict[str, Any]:
    """What Claude sees of a release: the fact to cite and the document's title, never the token."""
    title = next(claim.value for claim in fact.claims if claim.key == "title")
    return {"fact_id": fact.fact_id, "title": title, "link_ready": True}


class ReleaseDocumentAdapter:
    profile = PROFILE
    Args = ReleaseDocumentArgs
    free_text_fields: frozenset[str] = frozenset()
    model_view_keys = frozenset({"fact_id", "title", "link_ready"})
    releases_private_data = True          # a link to the verified person's document, read only as them

    async def normalize(self, nctx: NormalizeCtx, args: ReleaseDocumentArgs) -> Normalized:
        document = await find_document(nctx.ctx, nctx.desk_row.desk_id, fact_ref(args.document_id, "document"))
        if document is None:
            raise AdapterRefusal("no_such_document")
        return Normalized(resource=ResourceRef(kind="document", id=document.document_id,
                                               owner_person_id=document.record_owner_person_id),
                          recipient="verified_contact")

    async def execute(self, xctx: ExecCtx, action: NormalizedAction, args: ReleaseDocumentArgs) -> AdapterResult:
        """A link to the document the action resolved, for the person the session is verified as.
        A document that changed hands since the execution re-check fails it before anything is
        written."""
        ctx, session = xctx.ctx, xctx.session_row
        now = ctx.clock.now()
        person_id = labels.new_fact_label(session).record_owner
        document = await find_document(ctx, action.desk_id, action.resource.id)
        document_fact = await _document_fact(ctx, action.desk_id, action.resource.id)
        if (document is None or document_fact is None or person_id is None
                or document.record_owner_person_id != person_id or action.resource.owner_person_id != person_id):
            raise AdapterFailure("document_changed")
        token = secrets.token_urlsafe(32)
        link = DocumentLink(link_id=new_id("doclink"), copy_id=action.copy_id, desk_id=action.desk_id,
                            document_id=document.document_id, session_id=session.session_id, person_id=person_id,
                            token=token, token_sha256=token_sha256(token), created_at=now, expires_at=now + LINK_TTL)
        fact = Fact(fact_id=f"{FACT_PREFIX}{link.link_id}", kind="document", status="available", source="kernel",
                    claims=[Claim(key="title", kind="text", value=document.title),
                            Claim(key="ref", kind="ref", value=link.link_id)],
                    label=labels.combine([labels.label_of(document_fact.readers, document_fact.record_owner),
                                          labels.new_fact_label(session)]),
                    expires_at=link.expires_at)
        ctx.db.add(link)
        ctx.db.add(labels.fact_row(action.copy_id, action.desk_id, fact, now, session_id=session.session_id,
                                   action_id=action.action_id))
        await ctx.db.flush()
        await ledger.append(ctx, copy_id=action.copy_id, desk_id=action.desk_id, event=LedgerEvent(
            kind="document_link", origin="kernel", session_id=session.session_id, ref_id=link.link_id,
            summary={"link_id": link.link_id, "document_id": document.document_id, "issued": True}))
        return AdapterResult(facts=[fact], model_view=model_view(fact))

    async def reconcile(self, xctx: ExecCtx, action: NormalizedAction) -> AdapterResult | None:
        """The link the action made, if it made one: its fact names the action."""
        ctx = xctx.ctx
        row = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
            FactRow.desk_id == action.desk_id, FactRow.action_id == action.action_id)))).one_or_none()
        if row is None:
            return None
        fact = labels.fact_of(row)
        return AdapterResult(facts=[fact], model_view=model_view(fact))


ADAPTER = register(ReleaseDocumentAdapter())


# ---- The link after it is issued -------------------------------------------------------------------

def _openable(now: datetime) -> list[ColumnElement[bool]]:
    """A link that may still open: unopened, not voided, unexpired at `now`, and its document still
    its person's, on a Desk not deleted. The document and Desk conditions hold even if a link was
    issued as its person was removed or its Desk deleted."""
    return [DocumentLink.consumed_at.is_(None), DocumentLink.voided_at.is_(None), DocumentLink.expires_at > now,
            Document.copy_id == DocumentLink.copy_id, Document.desk_id == DocumentLink.desk_id,
            Document.document_id == DocumentLink.document_id,
            Document.record_owner_person_id == DocumentLink.person_id,
            Desk.copy_id == DocumentLink.copy_id, Desk.desk_id == DocumentLink.desk_id, Desk.deleted_at.is_(None)]


async def _expire_fact(ctx: KernelCtx, desk_id: str, link_id: str) -> FactRow | None:
    """The link's fact can't be cited once the link can't open; returns it (None if it has none)."""
    fact = (await ctx.db.scalars(ctx.repo.scoped(select(FactRow).where(
        FactRow.desk_id == desk_id, FactRow.fact_id == f"{FACT_PREFIX}{link_id}").with_for_update()))).one_or_none()
    if fact is not None:
        fact.status = "expired"
    await ctx.db.flush()
    return fact


def download_name(title: str | None) -> str:
    """The file name a released document goes out under (`Content-Disposition`), made from its
    link's fact's title and never from anything the visitor sent: the title's letters and digits
    in ASCII (accents dropped), every other run of characters as one hyphen, at most
    `DOWNLOAD_STEM_CHARS`, then `.txt`; `document.txt` when no letter or digit is left. Nothing in
    it needs quoting or escaping in a header."""
    ascii_title = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode("ascii")
    stem = re.sub(r"[^A-Za-z0-9]+", "-", ascii_title).strip("-")[:DOWNLOAD_STEM_CHARS].rstrip("-")
    return f"{stem or 'document'}.txt"


class OpenedDocument(NamedTuple):
    """A released document on its link's first open: its bytes, media type and file name."""
    body: bytes
    media_type: str
    filename: str


async def _ledger_link(ctx: KernelCtx, *, copy_id: str, desk_id: str, session_id: str, link_id: str,
                       **outcome: bool) -> None:
    """A `document_link` entry `{link_id, <outcome>: true}` on the link's Desk."""
    await ledger.append(ctx, copy_id=copy_id, desk_id=desk_id, event=LedgerEvent(
        kind="document_link", origin="kernel", session_id=session_id, ref_id=link_id,
        summary={"link_id": link_id, **outcome}))


async def open_document_link(ctx: KernelCtx, token: str) -> OpenedDocument:
    """`GET /document_links/{token}`: the document's bytes, media type and file name (from its
    fact's title, `download_name`), on the link's first open within `LINK_TTL`, in the request's
    transaction (unbound until the token's sha256 names a copy). The link is found by that hash
    alone, marked opened by one UPDATE, its fact expired and the open ledgered `{link_id, opened}`,
    all in that transaction. Any other link is 404 `not_found`, the same for all: one opened,
    expired or voided is ledgered `{link_id, refused}` on its Desk, and a token no link has is
    logged by the failure's reason alone. The token goes in no ledger entry or log line."""
    digest = token_sha256(token) if TOKEN.fullmatch(token) else None
    copy_id = await repo.copy_of_document_link(ctx, digest) if digest is not None else None
    if copy_id is None:
        raise KernelFailure(404, "not_found", "unknown_document_link")
    copy = ctx.bind(copy_id)
    now = ctx.clock.now()
    opened = (await ctx.db.execute(
        update(DocumentLink).where(DocumentLink.copy_id == copy_id, DocumentLink.token_sha256 == digest,
                                   *_openable(now))
        .values(consumed_at=now)
        .returning(DocumentLink.link_id, DocumentLink.desk_id, DocumentLink.session_id, Document.body)
        .execution_options(synchronize_session=False))).one_or_none()
    if opened is None:
        known = (await ctx.db.execute(copy.scoped(select(DocumentLink.link_id, DocumentLink.desk_id,
                                                         DocumentLink.session_id).where(
            DocumentLink.token_sha256 == digest)))).one_or_none()
        if known is None:
            raise KernelFailure(404, "not_found", "unknown_document_link")
        link_id, desk_id, session_id = known
        raise KernelFailure(404, "not_found", "document_link_refused", persist=partial(
            _ledger_link, copy_id=copy_id, desk_id=desk_id, session_id=session_id, link_id=link_id, refused=True))
    link_id, desk_id, session_id, body = opened
    fact = await _expire_fact(ctx, desk_id, link_id)
    await _ledger_link(ctx, copy_id=copy_id, desk_id=desk_id, session_id=session_id, link_id=link_id, opened=True)
    titles = [claim.value for claim in (fact.claims if fact is not None else []) if claim.key == "title"]
    title = titles[0] if titles and isinstance(titles[0], str) else None
    return OpenedDocument(body.encode("utf-8"), MEDIA_TYPE, download_name(title))


async def void_links(ctx: KernelCtx, desk_id: str, *, person_ids: Sequence[str] | None = None) -> list[str]:
    """Voids the Desk's links that haven't opened (only those released to one of `person_ids`,
    when given) in one UPDATE, in the caller's transaction; returns the voided links' IDs in order.
    Their facts are the caller's to expire (`expire_link_facts`) once it holds the rows it locks
    before facts (`repo.py`): a person's removal locks their documents in between."""
    now = ctx.clock.now()
    which = [DocumentLink.copy_id == ctx.copy_id, DocumentLink.desk_id == desk_id,
             DocumentLink.consumed_at.is_(None), DocumentLink.voided_at.is_(None)]
    if person_ids is not None:
        which.append(DocumentLink.person_id.in_(person_ids))
    return sorted((await ctx.db.execute(
        update(DocumentLink).where(*which).values(voided_at=now).returning(DocumentLink.link_id)
        .execution_options(synchronize_session=False))).scalars())


async def expire_link_facts(ctx: KernelCtx, desk_id: str, link_ids: Sequence[str]) -> None:
    """The facts of links that can no longer open (`void_links`), expired in the links' order, in
    the caller's transaction."""
    for link_id in link_ids:
        await _expire_fact(ctx, desk_id, link_id)


async def href_for(ctx: KernelCtx, fact: Fact) -> str:
    """The `document_link` card's `href`: `/api/d/{token}` for the link its fact names (its `ref`
    claim), which the API proxies to `GET /document_links/{token}`. A link that can no longer open
    raises `NothingToShow`, so its card isn't shown, even before its fact catches up."""
    link_id = next(claim.value for claim in fact.claims if claim.key == "ref")
    token = (await ctx.db.scalars(ctx.repo.scoped(select(DocumentLink.token).where(
        DocumentLink.link_id == link_id, *_openable(ctx.clock.now()))))).one_or_none()
    if token is None:
        raise render.NothingToShow(fact.fact_id)
    return f"/api/d/{token}"


render.register_template("document_link", {"document"}, render.en.document_link, render.es.document_link,
                         key=FACT_PREFIX, href_for=href_for)
