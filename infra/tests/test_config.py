"""DeskConfig: what the stacks are built from, read from `-c <key>=` or `DESK_<KEY>`."""

import pytest
from conftest import FIXTURE_CONTEXT, FIXTURE_IMAGE, make_app

from stacks import config as config_module
from stacks.config import PLACEHOLDER_SITE, ConfigError, ConfigWarning, DeskConfig

CERTIFICATE = "arn:aws:acm:us-east-1:123456789012:certificate/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"


def test_defaults_are_express_in_us_west_2():
    config = DeskConfig.from_app(make_app())

    assert config.compute == "express"
    assert config.region == "us-west-2"
    assert config.domain_name is None
    assert config.certificate_arn is None
    assert config.image_file == "infra/app.Dockerfile"
    assert (config.image_dir / config.image_file).is_file()
    assert config.kernel_image == "desk-kernel:dev"


@pytest.mark.parametrize(
    "context",
    [{"domain_name": "desk.example.com"}, {"certificate_arn": CERTIFICATE}],
    ids=["domain-only", "certificate-only"],
)
def test_domain_and_certificate_come_together(context):
    with pytest.raises(ConfigError, match="domain_name and certificate_arn"):
        DeskConfig.from_app(make_app(**context))

    config = DeskConfig.from_app(make_app(domain_name="desk.example.com", certificate_arn=CERTIFICATE))
    assert (config.domain_name, config.certificate_arn) == ("desk.example.com", CERTIFICATE)


def test_domain_and_certificate_come_from_the_environment_too():
    environ = {"DESK_DOMAIN_NAME": "desk.example.com", "DESK_CERTIFICATE_ARN": CERTIFICATE}

    config = DeskConfig.from_app(make_app(), environ=environ)

    assert (config.domain_name, config.certificate_arn) == ("desk.example.com", CERTIFICATE)


@pytest.mark.parametrize(
    "certificate_arn",
    [
        CERTIFICATE.replace("us-east-1", "us-west-2"),
        CERTIFICATE.replace(":acm:", ":iam:"),
        "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
    ],
    ids=["us-west-2", "not-acm", "not-an-arn"],
)
def test_cloudfront_certificate_must_be_us_east_1(certificate_arn):
    with pytest.raises(ConfigError, match="us-east-1"):
        DeskConfig.from_app(make_app(domain_name="desk.example.com", certificate_arn=certificate_arn))


@pytest.mark.parametrize("compute", ["fargate", "ALB", "express "])
def test_unknown_compute_is_rejected(compute):
    with pytest.raises(ConfigError, match="compute must be express or alb"):
        DeskConfig.from_app(make_app(compute=compute))

    assert DeskConfig.from_app(make_app(compute="alb")).compute == "alb"
    assert DeskConfig.from_app(make_app(), environ={"DESK_COMPUTE": "alb"}).compute == "alb"


def test_missing_web_build_uses_the_labelled_placeholder(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "DEFAULT_WEB_DIST", tmp_path / "web" / "dist")

    with pytest.warns(ConfigWarning, match="placeholder"):
        config = DeskConfig.from_app(make_app())

    assert config.web_dist == PLACEHOLDER_SITE
    assert config.placeholder_site is True
    page = (PLACEHOLDER_SITE / "index.html").read_text()
    assert '<meta name="desk-site" content="placeholder">' in page
    assert "being built" in page
    assert "Concept prototype by Giovanni Alcantara, not an Anthropic product" in page


def test_a_built_web_app_is_used_when_present(tmp_path, monkeypatch):
    dist = tmp_path / "web" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Claude Desk</title>")
    monkeypatch.setattr(config_module, "DEFAULT_WEB_DIST", dist)

    config = DeskConfig.from_app(make_app())

    assert (config.web_dist, config.placeholder_site) == (dist, False)


def test_a_named_web_build_must_exist(tmp_path):
    with pytest.raises(ConfigError, match="web_dist"):
        DeskConfig.from_app(make_app(web_dist=str(tmp_path / "missing")))


def test_public_origin_prefers_the_custom_domain():
    with_domain = make_app(
        domain_name="desk.example.com",
        certificate_arn=CERTIFICATE,
        public_origin="https://d111111abcdef8.cloudfront.net",
    )
    assert DeskConfig.from_app(with_domain).public_origin == "https://desk.example.com"

    given = make_app(public_origin="https://d111111abcdef8.cloudfront.net/")
    assert DeskConfig.from_app(given).public_origin == "https://d111111abcdef8.cloudfront.net"
    from_environment = {"DESK_PUBLIC_ORIGIN": "https://d111111abcdef8.cloudfront.net"}
    assert DeskConfig.from_app(make_app(), environ=from_environment).public_origin == (
        "https://d111111abcdef8.cloudfront.net"
    )

    with pytest.warns(ConfigWarning, match="pending.invalid"):
        assert DeskConfig.from_app(make_app()).public_origin == "https://pending.invalid"


@pytest.mark.parametrize(
    "public_origin",
    [
        "http://d111111abcdef8.cloudfront.net",
        "https://d111111abcdef8.cloudfront.net/app",
        "https://d111111abcdef8.cloudfront.net?x=1",
        "https://user@d111111abcdef8.cloudfront.net",
        "d111111abcdef8.cloudfront.net",
    ],
)
def test_public_origin_is_an_https_origin(public_origin):
    with pytest.raises(ConfigError, match="public_origin"):
        DeskConfig.from_app(make_app(public_origin=public_origin))


@pytest.mark.parametrize(
    "domain_name", ["https://desk.example.com", "desk.example.com/", "desk..example.com", "desk", "-desk.example.com"]
)
def test_domain_name_is_a_bare_host_name(domain_name):
    with pytest.raises(ConfigError, match="domain_name"):
        DeskConfig.from_app(make_app(domain_name=domain_name, certificate_arn=CERTIFICATE))

    config = DeskConfig.from_app(make_app(domain_name="Desk.Example.com", certificate_arn=CERTIFICATE))
    assert config.domain_name == "desk.example.com"


def test_image_comes_from_the_settings():
    config = DeskConfig.from_app(make_app(**FIXTURE_CONTEXT, kernel_image="desk-kernel:ci"))

    assert (config.image_dir, config.image_file, config.kernel_image) == (FIXTURE_IMAGE, "Dockerfile", "desk-kernel:ci")


@pytest.mark.parametrize("image_file", ["missing.Dockerfile", "../image/Dockerfile", "/etc/hosts"])
def test_image_file_must_be_inside_the_image_directory(image_file):
    with pytest.raises(ConfigError, match="image_file"):
        DeskConfig.from_app(make_app(image_dir=str(FIXTURE_IMAGE), image_file=image_file))


def test_git_sha_is_a_commit_or_unset():
    assert DeskConfig.from_app(make_app()).git_sha == "unset"
    sha = "1076e210e45a0822a03bc3cd006c34eb76bf9af2"
    assert DeskConfig.from_app(make_app(git_sha=sha)).git_sha == sha
    with pytest.raises(ConfigError, match="git_sha"):
        DeskConfig.from_app(make_app(git_sha="main"))
