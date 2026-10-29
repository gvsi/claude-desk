"""Shared helpers for the CDK tests: apps built with the repo's feature flags, never the caller's
environment, and the small Dockerfile fixture the stacks build their image from; and a loader
for the deploy scripts in infra/scripts, which run as plain files, not as a package."""

import importlib.util
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aws_cdk as cdk
import pytest

INFRA = Path(__file__).resolve().parents[1]
SCRIPTS = INFRA / "scripts"
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


def role_statements(template, role_id: str) -> list[dict]:
    """Every statement of every inline or attached customer policy on a role."""
    statements = []
    for policy in template.find_resources("AWS::IAM::Policy").values():
        if {"Ref": role_id} in policy["Properties"]["Roles"]:
            statements += policy["Properties"]["PolicyDocument"]["Statement"]
    role = template.find_resources("AWS::IAM::Role")[role_id]["Properties"]
    for policy in role.get("Policies", []):
        statements += policy["PolicyDocument"]["Statement"]
    return statements


def actions(statement: dict) -> list[str]:
    value = statement["Action"]
    return [value] if isinstance(value, str) else value


def resource_list(statement: dict) -> list:
    value = statement["Resource"]
    return value if isinstance(value, list) else [value]


# A deployed origin and commit, as deploy.sh passes them on the second DeskApp deploy.
APP_CONTEXT = {
    **FIXTURE_CONTEXT,
    "public_origin": "https://d111111abcdef8.cloudfront.net",
    "git_sha": "0123456789abcdef0123456789abcdef01234567",
}


@dataclass(frozen=True)
class DeskStacks:
    """Both stacks from one synthesis, so DeskApp's cross-stack references resolve to DeskData's
    outputs; `data_template` is DeskData as synthesized beside DeskApp."""

    config: Any
    data: Any
    desk_app: Any
    template: Any
    data_template: Any

    def source(self, value: Any) -> Any:
        """What a DeskApp value stands for in DeskData: a `Fn::GetStackOutput` becomes the DeskData
        output's value (such as `{"Ref": "ApiDbSecret0B70B063"}`), anything else is unchanged."""
        if isinstance(value, dict) and set(value) == {"Fn::GetStackOutput"}:
            reference = value["Fn::GetStackOutput"]
            assert reference["StackName"] == "DeskData", reference
            return self.data_template.to_json()["Outputs"][reference["OutputName"]]["Value"]
        return value

    def data_id(self, construct) -> str:
        """The logical ID of a DeskData construct."""
        return self.data.get_logical_id(construct.node.default_child)


def build_stacks(**context: str) -> DeskStacks:
    """DeskData and DeskApp as app.py builds them without credentials: us-west-2, no account."""
    from aws_cdk.assertions import Template

    from stacks.app_stack import DeskApp
    from stacks.config import DeskConfig
    from stacks.data_stack import DeskData

    with clean_environment():
        app = make_app(**{**APP_CONTEXT, **context})
        config = DeskConfig.from_app(app)
        env = cdk.Environment(region="us-west-2")
        data = DeskData(app, "DeskData", config=config, env=env)
        desk = DeskApp(app, "DeskApp", data=data, config=config, env=env)
        template = Template.from_stack(desk)
        return DeskStacks(config, data, desk, template, Template.from_stack(data))


@pytest.fixture(scope="session")
def desk_stacks() -> DeskStacks:
    return build_stacks()


def load_script(name: str):
    """A fresh copy of infra/scripts/<name>.py as a module, loaded the way `python <file>` runs it
    (its own directory, no package), so each test patches its own copy."""
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"desk_script_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unsigned_client(service: str):
    """A boto3 client in us-west-2 that never signs or looks for credentials, for Stubber tests."""
    import boto3
    import botocore
    from botocore.config import Config

    return boto3.client(service, region_name="us-west-2", config=Config(signature_version=botocore.UNSIGNED))
