"""The process's log record factory, as a kernel test finds it after the API's tests ran in the same process.

`create_app` installs the API's link-token redaction as the process's log record factory (`desk.api.log_redaction`),
and it stays installed for the rest of the process. In production the API and the kernel are separate processes;
in one pytest run, a kernel test that logs its own `/document_links/{token}` route template would read it back as
`<redacted>`. Every test puts the factory back after it runs (`tests/conftest.py`), so one that builds the API app
anywhere, not only among the API's tests, leaves the next test's log lines as they are.
"""

import logging
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
ROUTE_LINE = "kernel_failure route=GET /document_links/{token} status=404 code=not_found"


def test_a_kernel_route_template_is_logged_unchanged(caplog):
    caplog.set_level(logging.INFO, logger="desk.kernel_service")
    logging.getLogger("desk.kernel_service").info(ROUTE_LINE)
    assert [record.getMessage() for record in caplog.records] == [ROUTE_LINE]


def test_the_api_tests_leave_the_record_factory_as_they_found_it():
    """The settings tests, the OpenAPI tests (which build the app), then a kernel-side log line, in that order."""
    probe = f"{Path(__file__).relative_to(BACKEND)}::test_a_kernel_route_template_is_logged_unchanged"
    run = subprocess.run([sys.executable, "-m", "pytest", "-q", "-rA", "-p", "no:cacheprovider",
                          "tests/api/test_settings.py", "tests/api/test_openapi.py", probe],
                         cwd=BACKEND, capture_output=True, text=True, timeout=300)
    # The probe's own result first, so a failure in the two files before it is named as theirs, not the probe's.
    assert f"PASSED {probe}" in run.stdout.splitlines(), run.stdout[-4000:] + run.stderr[-2000:]
    assert run.returncode == 0, "the settings or OpenAPI tests failed in this run:\n" + run.stdout[-4000:]


def test_installing_the_api_redaction_outside_the_api_tests():
    """What building the API app does anywhere: the process's log records are redacted from now on."""
    from desk.api import log_redaction

    log_redaction.install()
    assert getattr(logging.getLogRecordFactory(), "_desk_redacts_link_tokens", False)


def test_a_test_outside_the_api_tests_leaves_the_record_factory_as_it_found_it():
    """A test outside tests/api that installs the redaction, then a kernel-side log line, in that order."""
    here = Path(__file__).relative_to(BACKEND)
    install = f"{here}::test_installing_the_api_redaction_outside_the_api_tests"
    probe = f"{here}::test_a_kernel_route_template_is_logged_unchanged"
    run = subprocess.run([sys.executable, "-m", "pytest", "-q", "-rA", "-p", "no:cacheprovider", "-p", "no:randomly",
                          install, probe], cwd=BACKEND, capture_output=True, text=True, timeout=300)
    assert f"PASSED {probe}" in run.stdout.splitlines(), run.stdout[-4000:] + run.stderr[-2000:]
