# Remote tests and kernel builds

Run from your worktree's root:

```sh
tools/testbox/run make kernel
tools/testbox/run uv run --project backend pytest backend/tests/kernel/test_sessions.py -q
make remote CMD="make web-test"
tools/testbox/run make web-e2e
tools/testbox/run make evals-tier1
```

A lane's first call takes about 5 minutes, to sync the worktree and build the lane's environment
and kernel, and says so on stderr ("setting up this lane"): the machine is reachable, so don't
retry. Later calls add seconds of overhead.

Test runs and kernel builds go through this machine by default (AGENTS.md, "Tests"); run them locally only when it's unreachable. Tier 2, model calls and jobs needing secrets stay local. `make dev` and browser
QA also stay on the laptop. CI continues using its own runners.

The always-on, on-demand test machine is a c8g.12xlarge (48 arm64 vCPUs, 96 GB RAM) in
us-east-1, with Ubuntu 24.04 and an encrypted 1 TiB gp3 root disk (16,000 IOPS, 1,000 MiB/s).
Budget about **$2.17/hour, $1,600/month** while running 24/7 (730 hours): roughly $1,397 for
[on-demand Linux compute](https://aws.amazon.com/ec2/pricing/on-demand/) at $1.91424/hour in
us-east-1, plus about $182 for the configured gp3 disk and a small public IPv4 charge
(before tax and data transfer; estimate dated 2026-11-01). It replaced a c8g.24xlarge (96 vCPUs,
about $4.08/hour) whose load peaked near 12 of its 96 vCPUs. Stop it when sustained parallel
testing ends or before an extended idle period; stopping ends compute charges but retains
the billed disk. The owner approves stopping or retiring it.
CI runners remain the merge gate, but their minutes per round trip slow interactive fixes;
local Docker keeps the compilation, containers and database load on the laptop that this
machine removes.

It has termination protection, requires IMDSv2, and has no inbound security group rules.
Access uses [SSH over SSM](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started-enable-ssh-connections.html).
Its instance role has no attached managed policies. Its one policy that allows anything is the inline
`claude-desk-test-box-session` (the account's deny-only inline policies may sit beside it, described
below), allowing only `ssm:UpdateInstanceInformation`,
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

## Trusted lanes and synchronization

The worktree directory name identifies the lane. Names requiring normalization receive a
hash suffix; `--lane scratch-name` selects a second scratch lane for experiments. Do not
reuse someone else's lane name. Agents are trusted. Lanes are kept apart by directory,
database and network namespace to prevent accidents, not to contain a hostile lane.
All jobs run as one Unix user with sudo and use one Postgres superuser; a lane can access
other lanes' files, processes and databases. This is not a privilege boundary.
The machine holds no secrets, and its role can only register with SSM and open SSM sessions
with the exact permissions listed above. Each lane has its own source copy, virtual environments,
kernel target directory, node_modules, temporary files, network namespace and Postgres
database. A lock covers both sync and execution, including callers from different laptops.
Network namespaces let two lanes use the same fixed test ports. Each run has a systemd
control group so child servers are stopped when the command finishes. Package download caches
and the Cargo registry are shared; compilation outputs are not. Cargo builds use eight
jobs per lane.

Each call has a unique service and a control-stream lease. Ctrl-C or SIGTERM closes the
lease; the client waits for remote cleanup before exiting. A call still waiting for its lane
(another caller holds it) or for the machine's setup lock has started no job, so it exits
at once, and its remote side stops waiting. If the client is killed,
EOF independently triggers the remote watchdog. The lane lock is released only after the
call's service and its whole process group are stopped, including detached descendants
in its control group. A killed process itself cannot wait for cleanup before exiting.

All lanes on a laptop share one connection, and Session Manager carries uploads slowly
(15–45 KB/s measured), so a keepalive reply can wait minutes behind other lanes' uploads.
The client allows ten minutes for one before closing the connection. If the connection
dies anyway, Session Manager can keep sshd's end open, and the dead connection's calls
keep their lane locks. sshd closes such a connection after ten minutes without a
keepalive reply, which ends those calls and frees their lanes: on the live machine, a
silenced connection's lane was free 11 to 12 minutes later. A call that waits more than
about 15 minutes for its lane is stuck: tell the CI lane.

A connection can also go silent without closing, after a dropped network or when the
laptop wakes from sleep. Every lane's calls then hang until the keepalives give up, up to
ten minutes. To close it at once, run
`for s in ~/.cache/desk-testbox/*.sock; do ssh -S "$s" -O exit x; done`. This ends every
running call from this laptop, and the next call opens a new connection.

An upload over 1 MB, such as a lane's first (an 11 MB Git bundle and about 30 MB of
source files), goes over a compressed connection of its own instead, which takes a few
seconds to open. The call then says "sending … MB over a connection of its own", and
other lanes' calls don't wait behind it. Compression shrinks the source files about
fourfold. On a quiet network a new lane's whole upload took 34 seconds, and round trips
on the shared connection stayed at 0.2 seconds throughout.

The client compares source content hashes under the lane lock and sends only changed files,
repairing sources edited or removed by a previous remote command and removing new
nonignored source files it created. Ignored build directories remain warm. It syncs tracked and
nonignored untracked source files, including
uncommitted edits and deletions. It excludes environment files (except `.env.example`),
private local directories, credential/key files and local build outputs. Do not put
secrets in source files or command arguments. Git history at HEAD and origin/main travels
as an incremental bundle when either ref changes, including unpushed commits, without copying
local Git configuration or hooks.
HEAD and the index use the caller's committed HEAD; staged and unstaged source changes
remain in the working tree.
A pending-transfer manifest is saved before copying sources; paths left by an interrupted
sync are reconciled on the next call. Successful sync atomically promotes the manifest.
Changing branches removes stale synced files and invalidates affected build/schema caches.
The client transfers its own worker and helper modules separately from the selected tree;
another checkout's client works with `--lane` even on a branch without `tools/testbox`.
Each client sends its protocol version. The launcher accepts the current version and the one
before it, so from the next version on a client one version behind keeps working. Version 2 is
the first that clients send: clients from before it send none and are refused, and must update
their branch's `tools/testbox`. Runner diagnostics go to stderr; set `TESTBOX_TIMING=1`
for phase timings. Exit 75 means the test machine is bootstrapping: retry shortly. Exit 78
means its last setup failed or was cut short: re-run `tools/testbox/provision.sh`.
Do merges, rebases, fetches and commits locally: the remote copy is disposable and nothing comes back.
Remote test reports remain in the lane; source files are never copied back automatically.

Changed kernel sources or build inputs trigger `make kernel` before the requested command.
Web dependencies install automatically (`npm ci` in web/, from the shared npm cache) on a lane's first call and whenever web/package.json or web/package-lock.json changes, so narrow web commands work without `make web-test`. A failed install stops the call, whatever its command, and the next call retries it; keep web/package.json and web/package-lock.json in agreement.
Each database is cloned from a template keyed by migration inputs and migrated with the
same development role passwords as `make db-roles`. A schema change recreates that lane's
throwaway database. Lanes reach Postgres directly at the test bridge's address,
`10.200.0.1:5432`, from their network namespace; the loopback forwarder on `127.0.0.1:5432`
remains for clients from older branches. The dedicated Postgres 16 server disables fsync,
synchronous_commit and full_page_writes: its data is disposable. It never connects to a
laptop database.

The account's deny-only inline policies may also be on the role. Provisioning accepts any other inline
policy, whatever its name, when all its statements deny, since such a policy can't grant anything, and
never removes one. Another inline policy that allows anything, or has no statements, is refused. Before
deleting the role by hand, delete its inline policies first, or `delete-role` fails; provisioning's own
rollback does this for a role it created.

## Replace in the same region

A replacement (another size, say) is proven beside the active machine before any lane moves to it:

```sh
tools/testbox/provision.sh --region us-east-1 --standby    # launch and bootstrap the standby
tools/testbox/run --standby make kernel                    # prove it from a lane; other lanes stay put
tools/testbox/provision.sh --region us-east-1 --promote    # every lane moves on its next call
```

Clients only discover the one running instance tagged `Purpose=agent-test-box`, so the standby
(`agent-test-box-standby`) is reached only with `--standby`, which never changes the connection
other lanes share. Promotion refuses a standby whose setup is still running or failed, then
re-tags the old machine `agent-test-box-retired` before tagging the standby active, so an
interruption leaves no active machine, never two; re-running `--promote` finishes it from the tags.

Every lane's client, from any branch, reuses the laptop's shared connection while it is alive and
the machine recorded in `~/.cache/desk-testbox/connection-<region>.json`. Promotion opens a
connection to the new machine, records it, and stops the shared connection to the old one taking
new calls. For four minutes it keeps closing old connections and restoring the record, since a
call that chose the old machine just before the switch can reopen or record it. Then the old
machine's SSH server stops taking new connections (only its listener stops, so open sessions
continue; `systemctl start ssh.socket` there undoes it), so a later caller can't reopen one:
such a call, or one still queued behind another call in its lane there, fails once, and its
retry runs on the new machine. Calls already running there finish. Each lane's next call runs on the new machine and sets the lane up again
there (about 5 minutes the first time, as for any new lane). This moves the lanes of the laptop
that promotes; another laptop's lanes move once its connection to the old machine closes.

Once no call runs on the retired machine, lift its termination protection and terminate it, with
the owner's approval. To check, open a shell with
`aws ssm start-session --region us-east-1 --target <retired instance>` and run
`systemctl list-units 'desk-testbox-run-*'`: it should stay empty for a few minutes. Anything
scheduled against the old instance, such as a planned stand-down, must be pointed at the new one.
Provisioning accepts only the current machine size, so a branch from before a size change must
rebase before re-running `provision.sh`.

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
and the role's exact inline session policy document, that any other inline policy only denies
and that there are no managed policies, before starting or bootstrapping a reused box. Any
mismatch is refused. Use
`tools/testbox/provision.sh --region us-east-1 --check` for the same read-only validation.
Re-running reuses tagged resources and starts a stopped box. A failed provisioning attempt
rolls back resources it created and reports any cleanup failure. Existing resources are
preserved. Bootstrap runs once through SSM after cloud-init; provisioning waits for readiness and safely retries
an interrupted or changed bootstrap through SSM, with its log at
`/var/log/desk-testbox-bootstrap.log` and readiness marker `/opt/testbox/ready`.
Re-bootstrap removes readiness first and takes an exclusive machine lock, draining running
lanes that hold shared locks. Running lanes can delay re-provisioning by up to 25 minutes; if
they still hold the lock then, or a setup step fails, provisioning reports the failure and
runs exit 78 until a re-run succeeds. Postgres restarts only when its configuration changed.
Allow about ten minutes for a fresh bootstrap; provisioning waits up to thirty minutes.

The replacement is independent: no data migration is needed. After testing it, retire the
old protected instance and its regional security group with the owner's approval. The IAM
role/profile are global and reused across regions. Replacing it in the same region uses
a standby (above); plain re-provisioning reuses the tagged instance. Never disable termination protection as routine setup.

The bootstrap pins Rust 1.99.1, uv 0.13.0 (SHA-256 verified), Python 3.13, cvc5 1.4.2 and Node 24.21.0.
cvc5 is verified against [the repository checksums](../tools/cvc5.sha256). Playwright's
Chromium/WebKit and system dependencies are installed for a pin checked against the web lockfile by the tools tests.
The font inventory matches the minimal arm64 CI image: Playwright’s font packages, without
DejaVu from the server AMI. DejaVu changes the fallback text metrics in layout tests.
Bootstrap removes its core and mono packages after installing the browser fonts, so normal
`make web-test` runs need no font or browser overrides.
