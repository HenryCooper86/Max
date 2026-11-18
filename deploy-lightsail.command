#!/bin/bash
# Deploy to the AWS Lightsail test server (see README "Build & Deployment Pipeline").
# Double-click in Finder or run: ./deploy-lightsail.command
set -euo pipefail
cd "$(dirname "$0")"

KEY="${LIGHTSAIL_KEY:-/Users/admin/Desktop/LightsailDefaultKey-ap-northeast-2.pem}"
HOST="${LIGHTSAIL_HOST:-ubuntu@3.35.135.136}"
REMOTE_APP_DIR="${LIGHTSAIL_APP_DIR:-/home/ubuntu/app}"
HEALTH_URL="${LIGHTSAIL_HEALTH_URL:-https://max.bionicloud.net/health}"
READY_URL="${LIGHTSAIL_READY_URL:-https://max.bionicloud.net/ready}"
DEPLOY_BRANCH="${LIGHTSAIL_DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${LIGHTSAIL_DEPLOY_REMOTE:-gitlab}"
ALLOW_NON_MAIN="${LIGHTSAIL_ALLOW_NON_MAIN:-off}"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  echo "Fix the KEY path at the top of this script." >&2
  exit 1
fi
if [[ ! "$REMOTE_APP_DIR" =~ ^/home/ubuntu/[A-Za-z0-9._/-]+$ ]] ||
  [[ "$REMOTE_APP_DIR" == *"/../"* || "$REMOTE_APP_DIR" == */.. || "$REMOTE_APP_DIR" == *"//"* ]]; then
  echo "Refusing unsafe LIGHTSAIL_APP_DIR (must be a normalized path below /home/ubuntu): '$REMOTE_APP_DIR'" >&2
  exit 1
fi

# Production deploys must be reproducible from the reviewed GitLab branch.
# This catches the two easiest operator mistakes: archiving uncommitted work,
# or deploying a local commit that has not passed through the main-branch MR.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy a dirty working tree. Commit or stash every change first." >&2
  exit 1
fi
CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$ALLOW_NON_MAIN" != "on" && "$CURRENT_BRANCH" != "$DEPLOY_BRANCH" ]]; then
  echo "Refusing to deploy branch '$CURRENT_BRANCH'; switch to reviewed '$DEPLOY_BRANCH' first." >&2
  echo "Set LIGHTSAIL_ALLOW_NON_MAIN=on only for an intentional staging deploy." >&2
  exit 1
fi
LOCAL_COMMIT="$(git rev-parse HEAD)"
REMOTE_COMMIT="$(git ls-remote "$DEPLOY_REMOTE" "refs/heads/$DEPLOY_BRANCH" | awk '{print $1}')"
if [[ "$ALLOW_NON_MAIN" != "on" && ( -z "$REMOTE_COMMIT" || "$LOCAL_COMMIT" != "$REMOTE_COMMIT" ) ]]; then
  echo "Refusing to deploy: local HEAD does not match $DEPLOY_REMOTE/$DEPLOY_BRANCH." >&2
  echo "local:  $LOCAL_COMMIT" >&2
  echo "remote: ${REMOTE_COMMIT:-missing}" >&2
  exit 1
fi

# Deploy from a clean snapshot so local build caches, IDE state, and other
# ignored files can never be copied to the server. The temporary directory is
# validated by mktemp before it is registered for recursive cleanup.
DEPLOY_STAGE="$(mktemp -d /tmp/doubao-deploy.XXXXXX)"
DEPLOY_ACTIVATED="off"
REMOTE_NEXT_DIR=""
REMOTE_PREVIOUS_DIR="${REMOTE_APP_DIR}.previous"
REMOTE_FAILED_DIR=""
cleanup() {
  local exit_status=$?
  if [[ "$exit_status" -ne 0 && "$DEPLOY_ACTIVATED" == "on" ]]; then
    echo "==> Deployment failed after activation; restoring the previous release" >&2
    ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
      "set -e; rm -rf '$REMOTE_FAILED_DIR'; mv '$REMOTE_APP_DIR' '$REMOTE_FAILED_DIR'; mv '$REMOTE_PREVIOUS_DIR' '$REMOTE_APP_DIR'; pm2 restart max --update-env; rm -rf '$REMOTE_FAILED_DIR'" \
      || echo "Automatic rollback failed; inspect $HOST immediately." >&2
  fi
  [[ "$DEPLOY_STAGE" == /tmp/doubao-deploy.* ]] && rm -rf "$DEPLOY_STAGE"
  trap - EXIT
  exit "$exit_status"
}
trap cleanup EXIT

git archive HEAD | tar -x -C "$DEPLOY_STAGE"

# Stamp the build identity inside the clean snapshot. The server-side client
# build and relay use this file to tag sessions and /health.
GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
REMOTE_NEXT_DIR="${REMOTE_APP_DIR}.next-${GIT_COMMIT}"
REMOTE_FAILED_DIR="${REMOTE_APP_DIR}.failed-${GIT_COMMIT}"
printf '{\n  "gitCommit": "%s",\n  "deployedAt": "%s"\n}\n' \
  "$GIT_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOY_STAGE/build-info.json"
echo "==> Build stamp: $GIT_COMMIT"

# Build the exact archived commit locally. The Lightsail instance is deliberately
# small and can be OOM-killed by TypeScript/Vite; it only needs runtime packages.
if [[ ! -d node_modules ]]; then
  echo "Local node_modules is missing; run npm ci before deploying." >&2
  exit 1
fi
ln -s "$(pwd)/node_modules" "$DEPLOY_STAGE/node_modules"
echo "==> 1/4 Building archived commit locally"
(
  cd "$DEPLOY_STAGE"
  GIT_COMMIT="$GIT_COMMIT" npm run build
)

echo "==> 2/4 Staging source and built client on $HOST (server .env is protected)"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
  "rm -rf '$REMOTE_NEXT_DIR' && mkdir -p '$REMOTE_NEXT_DIR'"
rsync -azc --delete \
  --exclude='.git' --exclude='.env' --exclude='node_modules' \
  --exclude='.DS_Store' --exclude='.claude' \
  --exclude='android/.gradle' --exclude='android/.idea' \
  --exclude='android/.kotlin' --exclude='android/local.properties' \
  --exclude='android/app/build' --exclude='ios/build' \
  --exclude='ios/DerivedData' --exclude='ios/MaxHelmet.xcodeproj/xcuserdata' \
  --exclude='ios/MaxHelmet.xcodeproj/project.xcworkspace/xcuserdata' \
  --exclude='ios/MaxHelmet.xcodeproj/project.xcworkspace/xcshareddata' \
  -e "ssh -i '$KEY' -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  "$DEPLOY_STAGE/" "$HOST":"$REMOTE_NEXT_DIR/"

echo "==> 3/4 Installing runtime deps and activating the staged release"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
  "set -e; if [ -f '$REMOTE_APP_DIR/.env' ]; then cp -p '$REMOTE_APP_DIR/.env' '$REMOTE_NEXT_DIR/.env'; fi; cd '$REMOTE_NEXT_DIR'; npm ci --omit=dev --no-audit --no-fund"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
  "set -e; test -d '$REMOTE_APP_DIR'; test -d '$REMOTE_NEXT_DIR'; rm -rf '$REMOTE_PREVIOUS_DIR'; mv '$REMOTE_APP_DIR' '$REMOTE_PREVIOUS_DIR'; if ! mv '$REMOTE_NEXT_DIR' '$REMOTE_APP_DIR'; then mv '$REMOTE_PREVIOUS_DIR' '$REMOTE_APP_DIR'; exit 1; fi"
DEPLOY_ACTIVATED="on"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
  "cd '$REMOTE_APP_DIR' && pm2 restart max --update-env"

echo "==> 4/4 Health check"
HEALTH_RESPONSE=""
HEALTH_VERIFIED="off"
for attempt in {1..20}; do
  if HEALTH_RESPONSE="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 8 "$HEALTH_URL" 2>/dev/null)" &&
    printf '%s' "$HEALTH_RESPONSE" | EXPECTED_COMMIT="$GIT_COMMIT" node -e '
      let body = "";
      process.stdin.on("data", (chunk) => (body += chunk));
      process.stdin.on("end", () => {
        try {
          const health = JSON.parse(body);
          process.exit(health.ok === true && health.build?.gitCommit === process.env.EXPECTED_COMMIT ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    '
  then
    HEALTH_VERIFIED="on"
    break
  fi
  HEALTH_RESPONSE=""
  [[ "$attempt" -lt 20 ]] && sleep 2
done
if [[ "$HEALTH_VERIFIED" != "on" ]]; then
  echo "Deployment failed health verification for commit $GIT_COMMIT." >&2
  exit 1
fi
printf '%s\n' "$HEALTH_RESPONSE"

READY_RESPONSE=""
if ! READY_RESPONSE="$(curl --silent --show-error --connect-timeout 5 --max-time 8 "$READY_URL")"; then
  echo "Deployment could not reach the readiness endpoint." >&2
  exit 1
fi
if ! printf '%s' "$READY_RESPONSE" | EXPECTED_COMMIT="$GIT_COMMIT" node -e '
  let body = "";
  process.stdin.on("data", (chunk) => (body += chunk));
  process.stdin.on("end", () => {
    try {
      const ready = JSON.parse(body);
      const valid = ready.ok === true && Array.isArray(ready.issues) && ready.issues.length === 0 &&
        ready.build?.gitCommit === process.env.EXPECTED_COMMIT;
      process.exit(valid ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
'; then
  echo "Deployment is live but failed readiness verification: $READY_RESPONSE" >&2
  exit 1
fi
printf '%s\n' "$READY_RESPONSE"
DEPLOY_ACTIVATED="off"
echo "Done. Health and readiness match commit $GIT_COMMIT."
