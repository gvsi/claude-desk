#!/usr/bin/env bash
# Deploy Claude Desk to AWS (us-west-2) from the owner's own terminal. Every deploy runs the whole
# sequence and stops at the first step that fails:
#
#   1. the owner retypes the AWS account ID it prints;
#   2. preflight.py: a clean tree, HEAD on origin/main, HEAD's passing tier 2 results file, both
#      owner secrets set, the web app built and checked at HEAD;
#   3. make image image-check, tagged with the commit (desk-kernel:<sha>, which the app image is
#      built on, and desk-app:<sha>, checked for what it must hold, proof reports included); cdk
#      deploy is given that kernel image and this checkout, never DESK_IMAGE_*;
#   4. cdk deploy DeskData (network, database, secrets, the admin task definition);
#   5. run_admin_task.py: migrations and role passwords, before any new app task starts;
#   6. cdk deploy DeskApp with the commit and the Desk's public URL; on a first deploy without a
#      custom domain that URL is known only afterwards, so DeskApp is deployed once more with it;
#   7. smoke.py against the public URL, the task's security groups and public IP and, in Express
#      mode, the origin and its load balancer's security groups.
#
#   read -rs DESK_PASSCODE; export DESK_PASSCODE
#   infra/scripts/deploy.sh [--compute express|alb] [--allow-branch]
#
# The first deploy creates DeskData alone first, so the owner can set the two secrets it creates:
# `deploy.sh --data-only` runs steps 1 to 4 (preflight without the owner secrets or the web build)
# and stops. It needs no DESK_PASSCODE.
#
# A custom domain comes from DESK_DOMAIN_NAME and DESK_CERTIFICATE_ARN (an ACM certificate in
# us-east-1) in the owner's shell, never from the repo. cdk deploy asks for approval before any
# change that broadens IAM permissions or security group access, so it keeps the terminal for its
# own output; everything else, the CloudFormation events included, is also written to
# infra/out/deploy-<UTC time>.log.
set -euo pipefail

usage() {
  echo "usage: infra/scripts/deploy.sh [--compute express|alb] [--allow-branch] [--data-only]"
}

compute=express
allow_branch=
data_only=
while (($#)); do
  case $1 in
    --compute)
      if (($# < 2)); then usage >&2; exit 2; fi
      compute=$2
      shift 2
      ;;
    --compute=*) compute=${1#*=}; shift ;;
    --allow-branch) allow_branch=--allow-branch; shift ;;
    --data-only) data_only=--data-only; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case $compute in
  express | alb) ;;
  *) echo "deploy: --compute is express or alb, not $compute" >&2; exit 2 ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INFRA=$ROOT/infra
REGION=us-west-2
OUT=${DESK_DEPLOY_OUT:-$INFRA/out}

# Unattended: no terminal to retype the account ID or approve a change on, so DESK_DEPLOY_ACCOUNT
# must name the account.
unattended=
if [[ ! -t 0 || ! -t 1 ]]; then
  if [[ -z ${DESK_DEPLOY_ACCOUNT:-} ]]; then
    echo "deploy: run this in your own terminal: cdk deploy asks for approval there, and you retype the account ID" >&2
    echo "deploy: or set DESK_DEPLOY_ACCOUNT=<account ID> to deploy unattended" >&2
    exit 2
  fi
  unattended=1
fi
for name in DESK_IMAGE_DIR DESK_IMAGE_FILE DESK_KERNEL_IMAGE; do
  if [[ -n ${!name:-} ]]; then
    echo "deploy: unset $name: the deploy builds the image from this checkout at HEAD" >&2
    exit 2
  fi
done
if [[ -z $data_only && -z ${DESK_PASSCODE:-} ]]; then
  echo "deploy: export DESK_PASSCODE first (read -rs DESK_PASSCODE; export DESK_PASSCODE); the smoke checks sign in with it" >&2
  exit 2
fi

mkdir -p "$OUT"
log=$OUT/deploy-$(date -u +%Y%m%dT%H%M%SZ).log
# fd 3 stays the terminal, for cdk deploy; everything else goes to the terminal and the log.
exec 3>&1
exec > >(tee -a "$log") 2>&1
on_exit() {
  local status=$?
  if ((status)); then
    echo "deploy: stopped (exit $status); nothing after the failed step ran. Log: $log" >&2
  fi
}
trap on_exit EXIT

step() { printf '\n== %s (%s)\n' "$*" "$(date -u +%H:%M:%SZ)"; }
fail() {
  echo "deploy: $*" >&2
  exit 1
}

stack_output() {  # stack_output <stack> <key>: the output's value, empty when the stack or output doesn't exist
  local stack=$1 key=$2 value
  if ! value=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" --output text 2>&1); then
    if [[ $value == *"does not exist"* ]]; then
      return 0
    fi
    echo "deploy: can't read $stack's outputs: $value" >&2
    return 1
  fi
  if [[ $value == None ]]; then
    value=
  fi
  printf '%s\n' "$value"
}

# The web build preflight made; --data-only builds none and deploys no web app.
web_dist=
if [[ -z $data_only ]]; then
  web_dist=$ROOT/web/dist
fi

# cdk_deploy <stack> [cdk options...]: the pinned CLI, its stack outputs on the terminal (fd 3). At a
# terminal, cdk asks for approval there before any change that broadens IAM permissions or security
# group access. Unattended, it first logs those changes with a read-only diff of the same stack and
# context (stopping if the diff fails), then deploys with --require-approval never.
cdk_deploy() {
  local stack=$1
  shift
  local options=(--exclusively -c "compute=$compute" -c "git_sha=$sha" ${web_dist:+-c} ${web_dist:+"web_dist=$web_dist"}
    -c "kernel_image=desk-kernel:$sha" -c "image_dir=$ROOT" -c "image_file=infra/app.Dockerfile" "$@")
  if [[ -z $unattended ]]; then
    (cd "$INFRA" && npx --no-install cdk deploy "$stack" --require-approval broadening --progress events \
      "${options[@]}") >&3
    return
  fi
  echo "deploy: $stack's security-relevant changes (cdk diff --security-only); with no terminal to approve"
  echo "deploy: them on, $stack is deployed with --require-approval never"
  if ! (cd "$INFRA" && npx --no-install cdk diff "$stack" --security-only --method template --fail-on never \
    "${options[@]}"); then
    echo "deploy: cdk diff $stack failed, so $stack wasn't deployed" >&2
    return 1
  fi
  (cd "$INFRA" && npx --no-install cdk deploy "$stack" --require-approval never --progress events \
    "${options[@]}") >&3
}

sha=$(git -C "$ROOT" rev-parse HEAD)
domain=
if [[ -n ${DESK_DOMAIN_NAME:-} ]]; then
  domain=$(printf '%s' "$DESK_DOMAIN_NAME" | tr '[:upper:]' '[:lower:]')
fi
echo "deploy: commit $sha, compute $compute, region $REGION"
echo "deploy: ${domain:-no custom domain; the Desk is served at its CloudFront address}"
echo "deploy: log $log"

step "AWS account"
account=$(aws sts get-caller-identity --query Account --output text) || fail "no AWS credentials: set AWS_PROFILE"
echo "deploy: AWS profile ${AWS_PROFILE:-default}, account $account"
if [[ -n ${DESK_DEPLOY_ACCOUNT:-} ]]; then
  [[ $DESK_DEPLOY_ACCOUNT == "$account" ]] ||
    fail "DESK_DEPLOY_ACCOUNT is $DESK_DEPLOY_ACCOUNT, but the AWS credentials are for account $account; nothing was deployed"
  echo "deploy: DESK_DEPLOY_ACCOUNT names that account"
else
  read -r -p "Type that account ID to deploy to it: " typed
  [[ $typed == "$account" ]] || fail "the typed account ID isn't $account; nothing was deployed"
fi

step "Preflight"
uv run --project "$INFRA" python "$INFRA/scripts/preflight.py" ${allow_branch:+"$allow_branch"} \
  ${data_only:+"$data_only"} || fail "preflight failed; nothing was deployed"

# The address the Desk serves at now, which the API's links keep using.
previous=
expected=
if [[ -z $data_only ]]; then
  previous=$(stack_output DeskApp PublicUrl)
  if [[ -n $previous && -z $domain ]]; then
    host=${previous#https://}
    if [[ $host != *.cloudfront.net ]]; then
      fail "DeskApp serves $previous; export DESK_DOMAIN_NAME and DESK_CERTIFICATE_ARN for it, or this deploy would drop that address"
    fi
  fi
  if [[ -n $domain ]]; then
    expected=https://$domain
  else
    expected=$previous
  fi
fi

step "Image"
make -C "$ROOT" image image-check KERNEL_TAG="$sha" || fail "make image or image-check failed; nothing was deployed"

step "Deploy DeskData"
(cd "$INFRA" && npm ci --no-audit --no-fund) || fail "npm ci failed in infra/"
cdk_deploy DeskData || fail "cdk deploy DeskData failed"

if [[ -n $data_only ]]; then
  echo
  echo "deploy: DeskData is deployed in account $account. Next, set the two owner secrets with"
  echo "infra/scripts/set_secret.py (docs/deploy.md), then run infra/scripts/deploy.sh"
  exit 0
fi

step "Admin task: migrations and role passwords"
uv run --project "$INFRA" python "$INFRA/scripts/run_admin_task.py" || fail "the admin task failed; DeskApp wasn't deployed"

step "Deploy DeskApp"
if [[ -n $previous ]]; then
  cdk_deploy DeskApp -c "public_origin=$previous" || fail "cdk deploy DeskApp failed"
else
  cdk_deploy DeskApp || fail "cdk deploy DeskApp failed"
fi
url=$(stack_output DeskApp PublicUrl)
[[ -n $url ]] || fail "DeskApp has no PublicUrl output"
if [[ $url != "$expected" ]]; then
  step "Deploy DeskApp again with its public URL"
  echo "deploy: the API's links used ${expected:-the pending origin}; the Desk serves at $url"
  cdk_deploy DeskApp -c "public_origin=$url" || fail "cdk deploy DeskApp failed"
  again=$(stack_output DeskApp PublicUrl)
  [[ $again == "$url" ]] || fail "PublicUrl moved again, from $url to $again"
fi
deployed=$(stack_output DeskApp DeployedSha)
[[ $deployed == "$sha" ]] || fail "DeskApp reports commit ${deployed:-none}, not $sha"
echo "deploy: DeskApp serves $sha at $url"

step "Smoke checks"
cluster=$(stack_output DeskData ClusterName)
[[ -n $cluster ]] || fail "DeskData has no ClusterName output"
smoke=(--base-url "$url" --cluster "$cluster")
if [[ $compute == express ]]; then
  endpoint=$(stack_output DeskApp ServiceEndpoint)
  origin_host=${endpoint#*://}
  origin_host=${origin_host%%/*}
  [[ -n $origin_host ]] || fail "DeskApp has no ServiceEndpoint output to probe"
  load_balancer=$(stack_output DeskApp LoadBalancerArn)
  [[ -n $load_balancer ]] || fail "DeskApp has no LoadBalancerArn output whose security groups to check"
  smoke+=(--origin-host "$origin_host" --load-balancer-arn "$load_balancer")
fi
uv run --project "$INFRA" python "$INFRA/scripts/smoke.py" "${smoke[@]}" ||
  fail "the smoke checks failed: the deploy isn't done, and the thin slice isn't announced"

echo
echo "deploy: done. $sha serves at $url"
