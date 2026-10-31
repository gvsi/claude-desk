"""Safety can read current verification because private-data tools require prior verification."""

import pytest

from desk.contracts import Principal
from desk.db.models import Desk
from desk.kernel_service import adapters, auth, decide


@pytest.mark.parametrize(("kind", "mandate_id"), [("visitor", None), ("agent", None), ("agent", "mandate")])
def test_unverified_sessions_are_given_no_private_data_tools(kind, mandate_id):
    profiles = {profile.tool: profile for profile in adapters.registered_profiles()}
    private = {tool for tool, profile in profiles.items() if "private_data" in profile.effects}
    assert private >= {"native.release_document", "payments.list_charges", "payments.create_refund"}
    principal = Principal(kind=kind, session_id="session", copy_id="copy", desk_id="desk", person_id=None,
                          agent_key_id="key" if kind == "agent" else None, assurance="none", mandate_id=mandate_id)
    session = auth.SessionRow(session_id="session", kind=kind, preview=False)

    given = decide.tools_given(principal, session, Desk(desk_id="desk", answering=True), profiles)

    assert given
    assert not given & private
    assert all("private_data" not in profiles[tool].effects for tool in given)
