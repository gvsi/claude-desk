"""The Claude Desk CDK app (`npx cdk synth` runs it; cdk.json names it).

Stacks, all in us-west-2: DeskData (network, database, secrets, admin task) and DeskApp (the
two-container task and its compute, deployed after DeskData on every deploy). Settings come from
`-c <key>=` or `DESK_<KEY>` (stacks/config.py). Synth needs no AWS credentials; deploys are the
owner's, through infra/scripts/deploy.sh.
"""

import os

import aws_cdk as cdk

from stacks.app_stack import DeskApp
from stacks.config import DeskConfig
from stacks.data_stack import DeskData


def main() -> None:
    app = cdk.App()
    config = DeskConfig.from_app(app)
    env = cdk.Environment(account=os.environ.get("CDK_DEFAULT_ACCOUNT"), region=config.region)
    data = DeskData(app, "DeskData", config=config, env=env)
    DeskApp(app, "DeskApp", data=data, config=config, env=env)
    app.synth()


if __name__ == "__main__":
    main()
