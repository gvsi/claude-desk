"""Shared helpers for the CDK tests: apps built with the repo's feature flags, never the caller's
environment, and the small Dockerfile fixture the stacks build their image from."""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import aws_cdk as cdk
import pytest

INFRA = Path(__file__).resolve().parents[1]
FIXTURE_IMAGE = Path(__file__).resolve().parent / "fixtures" / "image"
# What a test app sets so the stacks build their image from the fixture, not the repo.
FIXTURE_CONTEXT = {"image_dir": str(FIXTURE_IMAGE), "image_file": "Dockerfile"}


def feature_flags() -> dict:
    """The feature flags `cdk synth` passes the app, from cdk.json, so tests see the same templates."""
    return json.loads((INFRA / "cdk.json").read_text())["context"]


def make_app(**context: str) -> cdk.App:
    return cdk.App(context={**feature_flags(), **context})


@contextmanager
def clean_environment() -> Iterator[None]:
    """No DESK_* or CDK_* variable from the caller's shell reaches the app under test."""
    with pytest.MonkeyPatch.context() as patch:
        for name in list(os.environ):
            if name.startswith(("DESK_", "CDK_")):
                patch.delenv(name)
        yield


@pytest.fixture(autouse=True)
def _clean_environment() -> Iterator[None]:
    with clean_environment():
        yield


@pytest.fixture(scope="session")
def data_stack():
    """DeskData as app.py builds it without credentials: us-west-2, no account."""
    from stacks.config import DeskConfig
    from stacks.data_stack import DeskData

    with clean_environment():
        app = make_app(**FIXTURE_CONTEXT)
        return DeskData(app, "DeskData", config=DeskConfig.from_app(app), env=cdk.Environment(region="us-west-2"))


@pytest.fixture(scope="session")
def data_template(data_stack):
    from aws_cdk.assertions import Template

    return Template.from_stack(data_stack)
