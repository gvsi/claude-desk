# Remote tests and kernel builds

Run from your worktree's root:

```sh
tools/testbox/run make kernel
tools/testbox/run uv run --project backend pytest backend/tests/kernel/test_sessions.py -q
make remote CMD="make web-test"
tools/testbox/run make web-e2e
tools/testbox/run make evals-tier1
```

The remote machine is available for tests and kernel builds; it is not the default runner yet. Tier 2, model calls and jobs needing secrets stay local. `make dev` and browser
QA also stay on the laptop. CI continues using its own runners.

The always-on, on-demand test machine is a c8g.24xlarge (96 arm64 vCPUs, 192 GB RAM) in
us-east-1, with Ubuntu 24.04 and an encrypted 1 TiB gp3 root disk (16,000 IOPS, 1,000 MiB/s).
It has termination protection, requires IMDSv2, and has no inbound security group rules.
Access uses [SSH over SSM](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html).
Its instance role has no attached managed policies and exactly one inline policy,
`claude-desk-test-box-session`, allowing only `ssm:UpdateInstanceInformation`,
`ssmmessages:CreateControlChannel`, `CreateDataChannel`, `OpenControlChannel`,
`OpenDataChannel`, and `ec2messages:AcknowledgeMessage`, `DeleteMessage`, `FailMessage`,
`GetEndpoint`, `GetMessages`, `SendReply`, all on Resource `"*"`.
These permissions let the agent register and open SSM sessions. AmazonSSMManagedInstanceCore
is deliberately excluded: it also grants `ssm:GetParameter` and `ssm:GetParameters` across
the account, and processes on the machine can obtain its role credentials.
The machine holds no secrets: no business credentials,
API keys, deploy credentials or owner environment files; its generated `.env` uses only
`.env.example`'s public development defaults and the lane's database URLs.

## Client requirements

Use Python 3.10 or newer, Git, rsync, SSH, AWS CLI v2 and the Session Manager plugin. The plugin may be
installed in the user's local bin directory; the client adds that directory to PATH. Use
the default AWS profile with EC2 discovery, SSM SendCommand/GetCommandInvocation and
StartSession permissions. The stock macOS openrsync (protocol 29) works; Homebrew rsync is
optional. An SSH key and authenticated host-key record are kept in the user's cache, outside
the repository. Connections stay reusable for one hour; warm calls reuse a live authenticated connection without an AWS discovery request.

`tools/testbox/run` preserves argument boundaries. For compound commands use
`tools/testbox/run sh -c 'cd backend && uv run pytest tests/kernel/test_sessions.py -q'`.
`make remote CMD="..."` runs CMD through a shell. The remote working directory is the
repository root. CI is unset by default; use `tools/testbox/run --ci make evals-tier1` to
enable the strict landed gate explicitly. The caller's other environment variables are
never forwarded.

## Lane isolation and synchronization

The worktree directory name identifies the lane. Names requiring normalization receive a
hash suffix; `--lane scratch-name` selects a second scratch lane for experiments. Do not
reuse someone else's lane name. Each lane has its own source copy, virtual environments,
kernel target directory, node_modules, temporary files, network namespace and Postgres
database. A lock covers both sync and execution, including callers from different laptops.
Network namespaces let two lanes use the same fixed test ports. Each run has a systemd
control group so child servers are stopped when the command finishes. Package download caches
and the Cargo registry are shared; compilation outputs are not. Cargo builds use eight
jobs per lane.

The client compares source content hashes under the lane lock and sends only changed files,
repairing sources edited or removed by a previous remote command. It syncs tracked and
nonignored untracked source files, including
uncommitted edits and deletions. It excludes environment files (except `.env.example`),
private local directories, credential/key files and local build outputs. Do not put
secrets in source files or command arguments. Git history at HEAD and origin/main travels
as an incremental bundle when either ref changes, including unpushed commits, without copying
local Git configuration or hooks.
HEAD and the index use the caller's committed HEAD; staged and unstaged source changes
remain in the working tree.
Changing branches removes stale synced files and invalidates affected build/schema caches.
Remote test reports remain in the lane; source files are never copied back automatically.

Changed kernel sources or build inputs trigger `make kernel` before the requested command.
Each database is cloned from a template keyed by migration inputs and migrated with the
same development role passwords as `make db-roles`. A schema change recreates that lane's
throwaway database. The dedicated Postgres 16 server disables fsync, synchronous_commit
and full_page_writes: its data is disposable. It never connects to a laptop database.

## Re-create or move

```sh
tools/testbox/provision.sh --region us-east-1
# When moving, provision the replacement and select its region:
tools/testbox/provision.sh --region us-west-1
TESTBOX_REGION=us-west-1 tools/testbox/run make kernel
```

The script discovers resources by Project=claude-desk and Purpose=agent-test-box tags;
no account or instance ID belongs in source. It creates only a role/profile, a security
group in the default VPC and the instance with its root volume and primary interface.
Re-running checks the instance's attached profile ARN, the profile's sole role name and ARN,
and the role's exact inline session policy document with no managed policies before starting
or bootstrapping a reused box. Any mismatch is refused. Use
`tools/testbox/provision.sh --region us-east-1 --check` for the same read-only validation.
Re-running reuses tagged resources and starts a stopped box. A failed provisioning attempt
rolls back resources it created and reports any cleanup failure. Existing resources are
preserved. Bootstrap starts through cloud-init; provisioning waits for readiness and safely retries
an interrupted or changed bootstrap through SSM, with its log at
`/var/log/desk-testbox-bootstrap.log` and readiness marker `/opt/testbox/ready`.
Allow about ten minutes for a fresh bootstrap; provisioning waits up to thirty minutes.

The replacement is independent: no data migration is needed. After testing it, retire the
old protected instance and its regional security group with the owner's approval. The IAM
role/profile are global and reused across regions. Recreating in the same region requires
retiring the old instance first. Never disable termination protection as routine setup.

The bootstrap pins Rust 1.99.1, uv 0.13.0, Python 3.13, cvc5 1.4.2 and Node 24.21.0.
cvc5 is verified against [the repository checksums](../tools/cvc5.sha256). Playwright's
Chromium/WebKit and system dependencies are installed for the version in the web lockfile.
The font inventory matches the minimal arm64 CI image: Playwright’s font packages, without
DejaVu from the server AMI. DejaVu changes the fallback text metrics in layout tests.
Bootstrap removes its core and mono packages after installing the browser fonts, so normal
`make web-test` runs need no font or browser overrides.
