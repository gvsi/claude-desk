"""PR path scoping must only skip suites whose inputs are known to be unchanged."""

import ast
import os
import posixpath
import re
import subprocess
from pathlib import Path

import pytest

from desk_tools.changed_paths import classify, main


ROOT = Path(__file__).resolve().parents[2]
LITERAL = r'''(?:'[^'\n]*'|"[^"\n]*"|`[^`]*`)'''


def tracked_files(*folders):
    return subprocess.run(
        ["git", "ls-files", "-z", "--", *folders], cwd=ROOT,
        check=True, capture_output=True, text=True,
    ).stdout.rstrip("\0").split("\0")


def path_arguments(source, start):
    """Split a JS call without splitting nested dirname/URL calls or template strings."""
    parts, begin, depth, quote = [], start, 0, None
    for i in range(start, len(source)):
        char = source[i]
        if quote:
            if char == quote and source[i - 1] != "\\":
                quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            if not depth:
                return [*parts, source[begin:i].strip()]
            depth -= 1
        elif char == "," and not depth:
            parts.append(source[begin:i].strip())
            begin = i + 1
    return []


def web_read_paths(file, source):
    """Recognize the imports, URL reads, path calls and local path aliases used by web.

    Keep parent-relative literals even outside a recognized call, including ?raw imports.
    Resolve path.join(web, '..', ...) against its declared alias, not scripts/.
    Dynamic filename templates become globs; directory aliases alone aren't file reads.
    """
    folder = posixpath.dirname(file)
    aliases = {}

    def resolve(expression):
        expression = expression.strip()
        if re.fullmatch(LITERAL, expression):
            return re.sub(r"\$\{[^}]+\}", "*", expression[1:-1]).split("?", 1)[0]
        if expression in aliases:
            return aliases[expression]
        if expression in ("path.dirname(fileURLToPath(import.meta.url))", "dirname", "__dirname"):
            return folder
        if expression == "import.meta.url":
            return file
        if expression.startswith("fileURLToPath("):
            return resolve(path_arguments(expression, expression.index("(") + 1)[0])
        match = re.match(r"(?:path\.)?(join|resolve)\(|new URL\(", expression)
        if match:
            args = [resolve(arg) for arg in path_arguments(expression, match.end())]
            if not args or any(arg is None for arg in args):
                return None
            if expression.startswith("new URL"):
                # One argument parses an address; only new URL(path, base) names a file.
                if len(args) < 2:
                    return None
                return posixpath.normpath(posixpath.join(posixpath.dirname(args[1]), args[0]))
            if args[0].startswith("."):
                args.insert(0, folder)
            return posixpath.normpath(posixpath.join(*args))
        return None

    for declaration in re.finditer(r"\bconst\s+(\w+)\s*=\s*([^;]+);", source):
        value = resolve(declaration[2])
        if value is not None:
            aliases[declaration[1]] = value
    candidates = []
    for literal in re.finditer(LITERAL, source):
        value = resolve(literal[0])
        if value.startswith("../"):
            candidates.append(posixpath.normpath(posixpath.join(folder, value)))
    for call in re.finditer(r"(?:path\.)?(?:join|resolve)\(|new URL\(", source):
        value = resolve(source[call.start():])
        if value:
            candidates.append(value)
    return {
        path for path in candidates
        if not path.startswith("web/") and not (ROOT / path).is_dir()
    }


def test_web_external_reads_always_select_web():
    reads = set()
    for file in tracked_files("web"):
        if any(part in {"node_modules", "dist", "storybook-static"} for part in Path(file).parts):
            continue
        try:
            source = (ROOT / file).read_text()
        except UnicodeDecodeError:
            continue
        for path in web_read_paths(file, source):
            targets = [str(target.relative_to(ROOT)) for target in ROOT.glob(path)] if "*" in path else [path]
            assert targets, (file, path)
            for target in targets:
                reads.add(target)
                assert classify([target], "pull_request")["web"] is True, (file, target)
    assert {"backend/desk/api/openapi.json", "backend/desk/contracts.py", "docs/product-proposal.md"} <= reads


@pytest.mark.parametrize("expression", [
    "import input from '../../backend/new.json';",
    "import input from '../../backend/new.json?raw';",
    "path.join(__dirname, '..', '..', 'backend', 'new.json')",
    "path.join('..', '..', 'backend', 'new.json')",
    'path.resolve(__dirname, "..", "..", "backend", "new.json")',
    "new URL('../../backend/new.json', import.meta.url)",
    "const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');\n"
    "path.join(web, '..', 'backend', 'new.json')",
    "const BACKEND = path.join(__dirname, '..', '..', 'backend');\n"
    "path.join(BACKEND, 'new.json')",
    "path.join(__dirname, '..', '..', 'backend', `${language}.json`)",
])
def test_web_read_scan_sees_relative_literals_segments_urls_and_aliases(expression):
    paths = web_read_paths("web/scripts/read.mjs", expression)
    assert "backend/new.json" in paths or "backend/*.json" in paths


@pytest.mark.parametrize("expression", [
    "new URL(`http://${label}`)",
    "new URL('https://example.com/')",
    "new URL(href)",
])
def test_web_read_scan_skips_a_one_argument_url(expression):
    # new URL(address) parses an address; only new URL(path, base) names a file.
    assert web_read_paths("web/src/ds/components/ChatMarkdown/ChatMarkdown.tsx", expression) == set()


# These deployment paths do not make a CI suite consume the web source. CI synth uses
# the site placeholder; preflight/deploy build the web app only during owner-run deployment.
# Their tests create temporary dist files or inspect commands, rather than building web.
WEB_REFERENCE_ALLOWLIST = {
    "infra/scripts/deploy.sh": {"web/dist"},
    "infra/scripts/preflight.py": {"web", "web/package.json", "web/dist"},
    "infra/stacks/config.py": {"web", "web/dist"},
    "infra/tests/test_config.py": {"web"},
    "infra/tests/test_deploy.py": {"web"},
    "infra/tests/test_edge.py": {"web"},
    "infra/tests/test_preflight.py": {"web", "web/package.json"},
}


def test_backend_scoped_sources_do_not_read_web_except_deployment_paths():
    references = {}
    for file in tracked_files("backend", "evals", "kernel", "infra"):
        if file.endswith(".md"):
            continue
        try:
            source = (ROOT / file).read_text()
        except UnicodeDecodeError:
            continue
        # Includes Python's repo / "web" / "dist", JS joined segments, relative
        # imports and shell's $ROOT/web/dist. Ignore ordinary prose containing web.
        paths = set(re.findall(r'''["'`](?:\.{1,2}/)*(web/[^\s"'`]+)''', source))
        if re.search(r'''/\s*["']web["']|(?:path\.)?(?:join|resolve)\([^;\n]*["']web["']''', source):
            paths.add("web")
        paths.update(re.findall(r'''\$(?:ROOT|\{ROOT\})/(web/[^\s"'`]+)''', source))
        if paths:
            references[file] = paths
    assert references == WEB_REFERENCE_ALLOWLIST, "Remove stale deployment exceptions"


def test_tier2_gated_inputs_do_not_include_web():
    # Parse only this tuple; importing evals.results would pull in the evals environment.
    module = ast.parse((ROOT / "evals/results.py").read_text())
    [value] = [
        node.value for node in module.body if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "GATED_PATHS" for target in node.targets)
    ]
    paths = ast.literal_eval(value)
    assert paths and isinstance(paths, tuple)
    assert not any(path == "web" or path.startswith("web/") for path in paths), paths


@pytest.mark.parametrize(
    "paths, expected",
    [
        (["web/src/App.tsx"], {"backend": False, "web": True}),
        (["backend/desk/api/app.py", "evals/run.py", "kernel/core/src/lib.rs"], {"backend": True, "web": False}),
        (["web/package.json", "backend/desk/api/app.py"], {"backend": True, "web": True}),
        *[([path], {"backend": True, "web": True}) for path in [
            "docs/ci.md", ".github/workflows/ci.yml", "tools/desk_tools/gate.py", "Makefile", ".env.example",
            "backend/desk/contracts.schema.json", "backend/desk/api/openapi.json",
            "backend/desk/kernel_service/lexicon/en.txt", "backend/desk/kernel_service/lexicon/nested/es.txt",
            "backend/desk/contracts.py", "backend/desk/money_cap.py", "backend/desk/api/rules.py",
            "backend/desk/kernel_service/seed.py", "backend/desk/kernel_service/render/en.py",
        ]],
        ([], {"backend": True, "web": True}),
        *[(["web/App.tsx", path], {"backend": True, "web": True}) for path in [
            "", "../web/App.tsx", "/web/App.tsx", "web/../backend/app.py", "web//App.tsx",
            '"web/quoted\\nfile"', "web/new\nline", "web/", "web/./App.tsx",
        ]],
    ],
)
def test_classify_pr_paths(paths, expected):
    assert classify(paths, "pull_request") == expected


@pytest.mark.parametrize("event", ["push", "workflow_dispatch", "", "pull_request_target", "unexpected"])
@pytest.mark.parametrize("paths", [[], ["web/package.json"], ["backend/desk/api/app.py"]])
def test_only_pull_requests_are_scoped(event, paths):
    assert classify(paths, event) == {"backend": True, "web": True}


@pytest.mark.parametrize("parents, head", [
    (["base"], "pr-head"),
    (["base", "another-head"], "pr-head"),
    (["base", "pr-head", "third-parent"], "pr-head"),
    (["base", "pr-head"], ""),
])
def test_unverified_merge_head_runs_every_suite(tmp_path, monkeypatch, parents, head):
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("PR_HEAD_SHA", head)

    def git(command, **kwargs):
        assert command == ["git", "show", "-s", "--format=%P", "HEAD"], "Unverified HEAD must not be diffed"
        return subprocess.CompletedProcess(command, 0, stdout=" ".join(parents) + "\n")

    monkeypatch.setattr(subprocess, "run", git)
    main()
    assert output.read_text() == "backend=true\nweb=true\n"


@pytest.mark.parametrize("diff, backend, web", [
    ("web/src/App.tsx\n", "false", "true"),
    ("backend/desk/api/app.py\n", "true", "false"),
    ("", "true", "true"),
    ('"web/escaped\\nfile"\n', "true", "true"),
    (OSError("git missing"), "true", "true"),
    (subprocess.CalledProcessError(128, "git"), "true", "true"),
    (subprocess.TimeoutExpired("git", 30), "true", "true"),
    (UnicodeDecodeError("utf8", b"\xff", 0, 1, "invalid"), "true", "true"),
])
def test_job_writes_explicit_outputs_or_runs_everything_on_git_error(tmp_path, monkeypatch, diff, backend, web):
    output = tmp_path / "outputs"
    output.write_text("existing=value\n")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("PR_HEAD_SHA", "pr-head")

    def git(command, **kwargs):
        assert kwargs == {"check": True, "capture_output": True, "text": True, "timeout": 30}
        if isinstance(diff, Exception):
            raise diff
        if command == ["git", "show", "-s", "--format=%P", "HEAD"]:
            return subprocess.CompletedProcess(command, 0, stdout="base pr-head\n")
        assert command == ["git", "-c", "diff.renames=false", "diff", "--name-only", "HEAD^1", "HEAD"]
        return subprocess.CompletedProcess(command, 0, stdout=diff)

    monkeypatch.setattr(subprocess, "run", git)
    main()
    assert output.read_text() == f"existing=value\nbackend={backend}\nweb={web}\n"


@pytest.mark.parametrize("event", ["push", "workflow_dispatch", ""])
def test_non_pr_job_does_not_need_git(tmp_path, monkeypatch, event):
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", event)

    def no_git(*args, **kwargs):
        pytest.fail("Non-PR events must run everything without consulting git")

    monkeypatch.setattr(subprocess, "run", no_git)
    main()
    assert output.read_text() == "backend=true\nweb=true\n"


@pytest.mark.parametrize("event", ["pull_request", "push", "workflow_dispatch", ""])
@pytest.mark.parametrize("diff", ["web/src/App.tsx\n", "backend/desk/api/app.py\n", "docs/ci.md\n", "", "../bad\n"])
def test_classifier_outputs_are_only_lowercase_true_or_false(tmp_path, monkeypatch, capsys, event, diff):
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_EVENT_NAME", event)
    monkeypatch.setenv("PR_HEAD_SHA", "pr-head")

    def git(command, **kwargs):
        stdout = "base pr-head\n" if command[1] == "show" else diff
        return subprocess.CompletedProcess(command, 0, stdout=stdout)

    monkeypatch.setattr(subprocess, "run", git)
    main()
    assert capsys.readouterr().out == output.read_text()
    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert set(values) == {"backend", "web"}
    assert set(values.values()) <= {"true", "false"}


def test_merge_diff_includes_the_old_path_of_a_rename_into_web(tmp_path, monkeypatch):
    """A deleted backend input must not disappear behind git's rename detection."""
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        return subprocess.run(
            ["git", *args], cwd=repo, check=True, capture_output=True, text=True,
            env={"PATH": os.environ["PATH"], "HOME": str(tmp_path),
                 "GIT_AUTHOR_NAME": "CI test", "GIT_AUTHOR_EMAIL": "ci@example.test",
                 "GIT_COMMITTER_NAME": "CI test", "GIT_COMMITTER_EMAIL": "ci@example.test",
                 "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
        ).stdout

    git("init", "-b", "main")
    backend = repo / "backend"
    backend.mkdir()
    (backend / "input.txt").write_text("a backend input\n")
    git("add", ".")
    git("commit", "-m", "base")
    git("checkout", "-b", "change")
    (repo / "web").mkdir()
    (backend / "input.txt").rename(repo / "web/input.txt")
    git("add", ".")
    git("commit", "-m", "move input")
    monkeypatch.setenv("PR_HEAD_SHA", git("rev-parse", "HEAD").strip())
    git("checkout", "main")
    git("merge", "--no-ff", "change", "-m", "merge")
    output = tmp_path / "outputs"
    monkeypatch.chdir(repo)
    monkeypatch.setenv("GITHUB_EVENT_NAME", "pull_request")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    main()
    assert output.read_text() == "backend=true\nweb=true\n"
