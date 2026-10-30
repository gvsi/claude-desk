"""docs/deploy.md claims only what the scripts and the code enforce: how to go back to an earlier
release, now that every deploy runs the admin task first."""

import re

from conftest import INFRA

REPO = INFRA.parent
RUNBOOK = REPO / "docs" / "deploy.md"
MIGRATIONS = "backend/alembic/versions/"


def raw_section(title: str) -> str:
    """The runbook section under `## <title>`, as written."""
    match = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", RUNBOOK.read_text(), re.S | re.M)
    assert match, f"docs/deploy.md has no section {title!r}"
    return match.group(1)


def section(title: str) -> str:
    """The runbook section under `## <title>`, its lines joined into one."""
    return " ".join(raw_section(title).split())


def test_rollback_redeploys_an_earlier_commit_only_when_no_migration_shipped_since():
    """deploy.sh runs the admin task on every deploy, before DeskApp (test_deploy.py), and the admin
    run stops when the database is at a revision the code doesn't have
    (backend/tests/ops/test_admin.py, test_a_database_ahead_of_the_code_stops_the_admin_run).
    So once a later release's migration ran, the earlier commit can't be redeployed: the runbook
    must say so, show how to tell, and roll forward with the migration files kept."""
    rollback = section("Rollback and teardown")
    assert "only when no migration has shipped since" in rollback
    assert f"git log --oneline <commit>..origin/main -- {MIGRATIONS}" in rollback
    assert (REPO / MIGRATIONS).is_dir()
    assert "Can't locate revision" in rollback                    # what the admin task says then
    assert "before `DeskApp`" in rollback
    assert "roll forward" in rollback.lower()
    assert "keeps every migration file" in rollback
    assert "which is why each one works with the previous release" not in rollback


PRICED_ROW = re.compile(r"\| (?P<item>[^|]+) \| estimate: (?P<formula>[^|≈]+) ≈ \$(?P<figure>\d+) \|")
TOTAL_ROW = re.compile(r"\| Total \| estimate: about \$(?P<low>\d+)–(?P<high>\d+) \|")


def test_each_cost_formula_gives_its_figure():
    """Every priced row of the cost table states its whole formula, and the formula gives the
    figure; the total covers their sum plus the few dollars of the unpriced row."""
    table = [line for line in RUNBOOK.read_text().splitlines() if line.startswith("| ") and "estimate:" in line]
    unpriced = [line for line in table if "a few dollars" in line]
    [total] = [TOTAL_ROW.fullmatch(line) for line in table if line.startswith("| Total ")]
    priced = [line for line in table if line not in unpriced and not line.startswith("| Total ")]
    assert len(unpriced) == 1 and total and len(priced) == 5, table
    figures = []
    for line in priced:
        row = PRICED_ROW.fullmatch(line)
        assert row, f"not `estimate: <formula> ≈ $<figure>`: {line}"
        expression = row["formula"].replace("×", "*").replace("$", "")
        assert re.fullmatch(r"[0-9.()*+ ]+", expression), row["formula"]
        assert round(eval(expression)) == int(row["figure"]), row["item"]  # digits and operators only
        figures.append(int(row["figure"]))
    assert sum(figures) <= int(total["low"]) <= sum(figures) + 10 <= int(total["high"])


def test_the_log_keeps_all_of_cdk_deploy_but_its_stack_outputs():
    """As test_deploy.py proves: cdk deploy's diff and CloudFormation events reach the deploy log,
    and only its stack outputs stay on the terminal alone."""
    first = section("First deploy (owner's terminal)")
    assert "`cdk deploy`'s diff and CloudFormation events included" in first
    assert "only its stack outputs stay on the terminal alone" in first


def test_approval_is_claimed_only_for_changes_that_broaden_access():
    """deploy.sh passes `--require-approval broadening` (test_deploy.py), so cdk asks only before a
    change that broadens IAM permissions or security group access, not before every such change."""
    for path in (RUNBOOK, INFRA / "scripts" / "deploy.sh"):
        text = " ".join(path.read_text().replace("#", " ").split())
        assert "before any change that broadens IAM permissions or security group access" in text, path
        assert "IAM or security group change" not in text, path


def test_the_first_deploy_creates_desk_data_behind_the_account_check():
    """deploy.sh --data-only deploys DeskData alone after the owner retypes the account ID
    (test_deploy.py); the runbook's first deploy uses it, never a bare `cdk deploy`, which would
    target whichever account the ambient credentials resolve to."""
    match = re.search(r"^## First deploy \(owner's terminal\)\n.*?```sh\n(.*?)```", RUNBOOK.read_text(), re.S | re.M)
    assert match, "the first deploy has no sh block"
    commands = match.group(1)
    assert "cdk deploy" not in commands
    lines = [line.split("#", 1)[0].strip() for line in commands.splitlines()]
    assert "infra/scripts/deploy.sh --data-only" in lines
    assert lines.index("infra/scripts/deploy.sh --data-only") < next(
        i for i, line in enumerate(lines) if "set_secret.py" in line) < lines.index("infra/scripts/deploy.sh")


STORE_PASSCODE = 'security add-generic-password -s claude-desk-passcode -a "$USER" -w'
REDEPLOY = "DESK_DEPLOY_ACCOUNT=<account> infra/scripts/deploy.sh"


def sh_lines(title: str) -> list[str]:
    """The commands in a section's sh blocks, comments dropped."""
    blocks = re.findall(r"```sh\n(.*?)```", raw_section(title), re.S)
    return [line.split("  #", 1)[0].strip() for block in blocks for line in block.splitlines()]


def test_the_first_deploy_stores_the_passcode_where_deploy_sh_reads_it():
    """Without DESK_PASSCODE, deploy.sh reads the Keychain item claude-desk-passcode and, when it's
    missing, prints how to store it (test_deploy.py); the first deploy stores it with that command,
    before the full deploy that needs it."""
    script = (INFRA / "scripts" / "deploy.sh").read_text()
    assert STORE_PASSCODE in script
    assert "security find-generic-password -s claude-desk-passcode -w" in script
    lines = sh_lines("First deploy (owner's terminal)")
    assert STORE_PASSCODE in lines
    assert lines.index(STORE_PASSCODE) < lines.index("infra/scripts/deploy.sh")
    assert "read -rs DESK_PASSCODE; export DESK_PASSCODE" not in lines


def test_a_redeploy_is_one_line_and_the_runbook_says_what_it_skips():
    """With DESK_DEPLOY_ACCOUNT set deploy.sh asks nothing and runs without a terminal, logging each
    stack's security diff and deploying with --require-approval never (test_deploy.py)."""
    assert REDEPLOY in sh_lines("Redeploys")
    redeploys = section("Redeploys")
    assert "refuses, deploying nothing" in redeploys
    assert "`cdk diff --security-only`" in redeploys and "`--require-approval never`" in redeploys
    assert REDEPLOY in " ".join((INFRA / "scripts" / "deploy.sh").read_text().replace("#", " ").split())


def test_the_passcode_is_asked_for_in_printable_ascii():
    """deploy.sh refuses a Keychain passcode that isn't printable ASCII, or has a backslash, from how
    `security find-generic-password -g` shows the stored item (test_deploy.py). The runbook says so
    where the passcode is stored, and why, and claims no more than that check does."""
    first = section("First deploy (owner's terminal)")
    assert "The passcode must be printable ASCII with no backslash" in first
    assert "`security` hands any other back as hex" in first
    assert "`security find-generic-password -g`" in first
    assert "any other answer from `security -g` is refused too" in first      # it accepts one form alone
    assert "can't catch" not in first and "hex is itself printable ASCII" not in first
    script = " ".join((INFRA / "scripts" / "deploy.sh").read_text().replace("#", " ").split())
    assert "it must be printable ASCII with no backslash" in script
