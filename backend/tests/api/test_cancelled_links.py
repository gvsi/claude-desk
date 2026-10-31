"""Confirm paths publish the kernel's cancelled-link verdicts once, without undoing activation."""

import asyncio

import pytest
from sqlalchemy import select

from desk.api import link_notices
from desk.api.deps import owner_context
from desk.api.kernel_client import CredentialView, KernelFailed
from desk.api.link_notices import ROUTE
from desk.api.store import MESSAGES, RUN_EVENTS, append_message
from desk.contracts import PolicyVersion
from desk.events import EvMessage
from tests.api.conftest import new_visitor
from tests.api.test_owner_desks import new_owner
from tests.api.test_verification import stored_events
from tests.kernel_contract.test_contract import issue_payment_link


async def open_link(api, browser, fake, kernel_http, engine):
    owner = await new_owner(api, browser, fake, kernel_http)
    visitor = await new_visitor(kernel_http, fake, owner.copy)
    await issue_payment_link(visitor.kernel, visitor.ids.session_id, "deposit", 1)
    async with engine.begin() as conn:
        await append_message(conn, visitor.ids, "visitor_text", text="Can I pay?", wake=False)
    link = next(link for link in fake.payment_links.values() if link.session_id == visitor.ids.session_id)
    return owner, visitor, link


async def lower_cap(owner, cap=1000):
    path = f"/api/owner/policy/{owner.desk_id}"
    drafted = await owner.browser.post(f"{path}/money_cap", json={"auto_money_cap_cents": cap})
    assert drafted.status_code == 200, drafted.text
    version = drafted.json()["version"]
    return path, version


async def notices(engine, session_id):
    return [EvMessage.model_validate(event) for event in await stored_events(engine, session_id, "message")
            if any(block["template"] == "link_cancelled" for block in event["blocks"])]


async def test_money_cap_confirm_delivers_cancelled_link_to_chat(api, browser, fake, kernel_http, engine):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    assert link.state == "cancelled"
    (event,) = await notices(engine, visitor.ids.session_id)
    assert (event.author, event.generation) == ("desk", 0)
    assert [(block.template, block.fact_id) for block in event.blocks] == [
        ("link_cancelled", f"payment_link:{link.link_id}")]
    async with engine.connect() as conn:
        (row,) = (await conn.execute(select(MESSAGES).where(MESSAGES.c.session_id == visitor.ids.session_id,
                                                          MESSAGES.c.kind == "delivered"))).mappings().all()
        seq = (await conn.execute(select(RUN_EVENTS.c.seq).where(
            RUN_EVENTS.c.session_id == visitor.ids.session_id, RUN_EVENTS.c.type == "message"))).scalar_one()
    assert (row["author"], row["ref_id"], row["blocks"], row["event_seq"]) == (
        "desk", event.message_id, event.blocks, seq
    )


async def test_repeated_and_next_confirm_never_duplicate_a_links_notice(api, browser, fake, kernel_http, engine):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    for _ in range(2):
        api.state.runtime.proving.forget(owner.desk_id)  # another worker has no in-memory kept response
        responses = await asyncio.gather(*(owner.browser.post(f"{path}/confirm", json={"version": version})
                                           for _ in range(2)))
        assert all(response.status_code == 200 for response in responses)
    (first,) = await notices(engine, visitor.ids.session_id)
    path, next_version = await lower_cap(owner, 500)
    assert (await owner.browser.post(f"{path}/confirm", json={"version": next_version})).status_code == 200
    assert await notices(engine, visitor.ids.session_id) == [first]
    assert link.state == "cancelled"


async def test_confirm_with_no_cancelled_links_posts_nothing(api, browser, fake, kernel_http, engine):
    owner = await new_owner(api, browser, fake, kernel_http)
    path = f"/api/owner/policy/{owner.desk_id}"
    draft = await owner.browser.post(f"{path}/preset", json={"preset": "ask_first"})
    assert draft.status_code == 200, draft.text
    response = await owner.browser.post(f"{path}/confirm", json={"version": draft.json()["version"]})
    assert response.status_code == 200, response.text
    async with engine.connect() as conn:
        assert not (await conn.execute(select(MESSAGES.c.n).where(MESSAGES.c.kind == "delivered"))).all()


@pytest.mark.parametrize("malformed", ["other_link", "not_ok", "extra_block", "no_blocks", "other_template"])
async def test_unexpected_notice_verdict_is_skipped_before_lock(
        api, browser, fake, kernel_http, engine, monkeypatch, caplog, malformed):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    call = CredentialView.call
    locks = []
    run_lock = link_notices.run_lock

    async def intercept(self, route, *args, **kwargs):
        result = await call(self, route, *args, **kwargs)
        if route == ROUTE and kwargs["path"]["version"] == version:
            (notice,) = result
            (block,) = notice.verdict.blocks
            if malformed == "other_link":
                block = block.model_copy(update={"fact_id": "payment_link:another-link"})
            elif malformed == "other_template":
                block = block.model_copy(update={"template": "payment_link"})
            blocks = [] if malformed == "no_blocks" else [block, block] if malformed == "extra_block" else [block]
            return [notice.model_copy(update={"verdict": notice.verdict.model_copy(
                update={"ok": malformed != "not_ok", "blocks": blocks})})]
        return result

    async def track_lock(conn, session_id):
        locks.append(session_id)
        await run_lock(conn, session_id)

    monkeypatch.setattr(CredentialView, "call", intercept)
    monkeypatch.setattr(link_notices, "run_lock", track_lock)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    assert link.state == "cancelled"
    assert await notices(engine, visitor.ids.session_id) == []
    async with engine.connect() as conn:
        assert not (await conn.execute(select(MESSAGES.c.n).where(MESSAGES.c.kind == "delivered"))).all()
    assert locks == []
    assert f"link_notice_unexpected version={version} link_id={link.link_id}" in caplog.text
    assert any(record.levelname == "ERROR" and "link_notice_unexpected" in record.message
               for record in caplog.records)


@pytest.mark.parametrize("chat", ["no_api_rows", "another_copy"])
async def test_notice_without_a_chat_in_the_owners_copy_is_skipped(
        api, browser, fake, kernel_http, engine, monkeypatch, caplog, chat):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    target = await new_visitor(kernel_http, fake, owner.copy if chat == "no_api_rows" else None)
    if chat == "another_copy":
        async with engine.begin() as conn:
            await append_message(conn, target.ids, "visitor_text", text="Another chat.", wake=False)
    path, version = await lower_cap(owner)
    call = CredentialView.call

    async def intercept(self, route, *args, **kwargs):
        result = await call(self, route, *args, **kwargs)
        if route == ROUTE and kwargs["path"]["version"] == version:
            return [notice.model_copy(update={"session_id": target.ids.session_id}) for notice in result]
        return result

    monkeypatch.setattr(CredentialView, "call", intercept)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    assert link.state == "cancelled"
    assert await notices(engine, visitor.ids.session_id) == []
    assert await notices(engine, target.ids.session_id) == []
    async with engine.connect() as conn:
        assert not (await conn.execute(select(MESSAGES.c.n).where(MESSAGES.c.kind == "delivered"))).all()
    assert f"link_notice_no_chat version={version} link_id={link.link_id}" in caplog.text


async def test_confirm_conflict_after_activation_still_delivers_notices(
        api, browser, fake, kernel_http, engine, monkeypatch):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    call = CredentialView.call
    conflicts = []

    async def intercept(self, route, *args, **kwargs):
        result = await call(self, route, *args, **kwargs)
        if route == "POST /policy/confirm":
            # Another worker activated between the API's initial read and its confirm call.
            assert result.status == "active" and result.version == version
            conflicts.append(version)
            raise KernelFailed(409, "conflict")
        return result

    monkeypatch.setattr(CredentialView, "call", intercept)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "active"
    assert conflicts == [version] and link.state == "cancelled"
    (event,) = await notices(engine, visitor.ids.session_id)
    assert [(block.template, block.fact_id) for block in event.blocks] == [
        ("link_cancelled", f"payment_link:{link.link_id}")]


@pytest.mark.parametrize("failure", ["connect", "422", "500"])
async def test_failed_notice_read_keeps_confirm_success_and_next_confirm_retries_parent(
        api, browser, fake, kernel_http, engine, caplog, failure):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    fake.fail(ROUTE, failure)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "active" and link.state == "cancelled"
    assert await notices(engine, visitor.ids.session_id) == []
    assert f"link_notices_unavailable version={version} link_id=unknown" in caplog.text
    assert "Can I pay?" not in caplog.text
    fake.fail(ROUTE, None)
    path, next_version = await lower_cap(owner, 500)
    response = await owner.browser.post(f"{path}/confirm", json={"version": next_version})
    assert response.status_code == 200, response.text
    assert len(await notices(engine, visitor.ids.session_id)) == 1


@pytest.mark.parametrize("takeover", ["before_read", "after_read", "closed_after_read"])
async def test_notice_uses_current_generation_in_owner_mode_and_fences_a_race(
        api, browser, fake, kernel_http, engine, monkeypatch, caplog, takeover):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    call = CredentialView.call
    verdicts = []

    async def intercept(self, route, *args, **kwargs):
        result = await call(self, route, *args, **kwargs)
        if route == ROUTE and kwargs["path"]["version"] == version:
            verdicts.extend(notice.verdict for notice in result)
            if takeover == "after_read":
                fake.set_mode(visitor.ids.session_id, "owner")
            elif takeover == "closed_after_read":
                fake.sessions[visitor.ids.session_id].closed_at = fake.now
                fake._put_session(fake.sessions[visitor.ids.session_id])
                fake.flush()
        return result

    if takeover == "before_read":
        fake.set_mode(visitor.ids.session_id, "owner")
    monkeypatch.setattr(CredentialView, "call", intercept)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    if takeover == "before_read":
        (event,) = await notices(engine, visitor.ids.session_id)
        (verdict,) = verdicts
        assert (event.author, event.generation, event.blocks, event.signature, event.message_id, event.ledger_seq) == (
            "desk", 1, verdict.blocks, verdict.signature, verdict.message_id, verdict.ledger_seq)
    else:
        assert await notices(engine, visitor.ids.session_id) == []
        reason = "fenced" if takeover == "after_read" else "no_chat"
        assert f"link_notice_{reason} version={version} link_id={link.link_id}" in caplog.text
        if takeover == "after_read":
            monkeypatch.setattr(CredentialView, "call", call)
            api.state.runtime.proving.forget(owner.desk_id)
            response = await owner.browser.post(f"{path}/confirm", json={"version": version})
            assert response.status_code == 200
            (event,) = await notices(engine, visitor.ids.session_id)
            assert event.generation == 1


async def test_delivery_failure_rolls_back_notice_and_concurrent_retries_show_it_once(
        api, browser, fake, kernel_http, engine, monkeypatch, caplog):
    owner, visitor, link = await open_link(api, browser, fake, kernel_http, engine)
    path, version = await lower_cap(owner)
    deliver = link_notices.deliver

    async def fail_after_write(*args, **kwargs):
        await deliver(*args, **kwargs)
        raise RuntimeError("visitor content must not be logged")

    monkeypatch.setattr(link_notices, "deliver", fail_after_write)
    response = await owner.browser.post(f"{path}/confirm", json={"version": version})
    assert response.status_code == 200, response.text
    assert link.state == "cancelled" and await notices(engine, visitor.ids.session_id) == []
    assert f"link_notice_failed version={version} link_id={link.link_id} error=RuntimeError" in caplog.text
    assert "visitor content must not be logged" not in caplog.text
    monkeypatch.setattr(link_notices, "deliver", deliver)
    async with owner_context(api.state.runtime, owner.token) as ctx:
        await asyncio.gather(*(link_notices.tell_cancelled_links(ctx, engine, owner.desk_id,
                                                               PolicyVersion.model_validate(response.json()))
                               for _ in range(2)))
    assert len(await notices(engine, visitor.ids.session_id)) == 1
