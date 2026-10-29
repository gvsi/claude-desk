"""docs/deploy.md claims only what the scripts and the code enforce: how to go back to an earlier
release, now that every deploy runs the admin task first."""

import re

from conftest import INFRA

REPO = INFRA.parent
RUNBOOK = REPO / "docs" / "deploy.md"
MIGRATIONS = "backend/alembic/versions/"


def section(title: str) -> str:
    """The runbook section under `## <title>`, its lines joined into one."""
    match = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", RUNBOOK.read_text(), re.S | re.M)
    assert match, f"docs/deploy.md has no section {title!r}"
    return " ".join(match.group(1).split())


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
