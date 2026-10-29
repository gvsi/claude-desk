"""The one app image both task containers and the admin task run: infra/app.Dockerfile layered on
the kernel image (`make image` builds `desk-kernel:dev` first), linux/arm64."""

from aws_cdk import aws_ecr_assets as ecr_assets
from aws_cdk import aws_ecs as ecs
from constructs import Construct

from stacks.config import DeskConfig

_ASSET_ID = "DeskImage"


def desk_image(scope: Construct, config: DeskConfig) -> ecs.ContainerImage:
    """The app image as a Docker asset in `scope`, built from the repo root at deploy (synth only
    stages the context, minus .dockerignore). Repeated calls in one scope share the asset."""
    asset = scope.node.try_find_child(_ASSET_ID)
    if asset is None:
        asset = ecr_assets.DockerImageAsset(
            scope,
            _ASSET_ID,
            directory=str(config.image_dir),
            file=config.image_file,
            build_args={"KERNEL_IMAGE": config.kernel_image},
            platform=ecr_assets.Platform.LINUX_ARM64,
        )
    return ecs.ContainerImage.from_docker_image_asset(asset)
