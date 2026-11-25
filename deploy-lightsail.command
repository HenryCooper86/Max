#!/bin/bash
# Deploy the relay and web app to a Lightsail (or any Ubuntu + pm2) host, verify
# /health and /ready report the new commit, and roll back if they do not.
# Double-click in Finder or run: ./deploy-lightsail.command
#
# The host and SSH key are yours, so they are not in this file. Put them in
# deploy.local.env next to this script (ignored by git), or export them:
#
#   LIGHTSAIL_KEY=/path/to/key.pem
#   LIGHTSAIL_HOST=ubuntu@your-server
#   LIGHTSAIL_HEALTH_URL=https://your-domain/health
#   LIGHTSAIL_READY_URL=https://your-domain/ready
#
# Optional: with TESTING_GATE_URL (and TESTING_GATE_TOKEN if the QA relay needs
# one) set, the deploy first asks that relay's release gate whether this exact
# commit passed live-agent testing and was approved, and stops if not. See
# docs/live-agent-testing.md. Without it the deploy says so and goes ahead.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f deploy.local.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./deploy.local.env
  set +a
fi

KEY="${LIGHTSAIL_KEY:-}"
HOST="${LIGHTSAIL_HOST:-}"
REMOTE_APP_DIR="${LIGHTSAIL_APP_DIR:-/home/ubuntu/app}"
HEALTH_URL="${LIGHTSAIL_HEALTH_URL:-}"
READY_URL="${LIGHTSAIL_READY_URL:-}"
DEPLOY_BRANCH="${LIGHTSAIL_DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${LIGHTSAIL_DEPLOY_REMOTE:-origin}"
ALLOW_NON_MAIN="${LIGHTSAIL_ALLOW_NON_MAIN:-off}"

missing=()
[[ -n "$KEY" ]] || missing+=("LIGHTSAIL_KEY")
[[ -n "$HOST" ]] || missing+=("LIGHTSAIL_HOST")
[[ -n "$HEALTH_URL" ]] || missing+=("LIGHTSAIL_HEALTH_URL")
[[ -n "$READY_URL" ]] || missing+=("LIGHTSAIL_READY_URL")
if (( ${#missing[@]} > 0 )); then
  echo "Missing deploy settings: ${missing[*]}" >&2
  echo "Set them in deploy.local.env next to this script, or export them." >&2
  exit 1
fi
if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  echo "Fix LIGHTSAIL_KEY in deploy.local.env." >&2
  exit 1
fi
if [[ ! "$REMOTE_APP_DIR" =~ ^/home/ubuntu/[A-Za-z0-9._/-]+$ ]] ||
  [[ "$REMOTE_APP_DIR" == *"/../"* || "$REMOTE_APP_DIR" == */.. || "$REMOTE_APP_DIR" == *"//"* ]]; then
  echo "Refusing unsafe LIGHTSAIL_APP_DIR (must be a normalized path below /home/ubuntu): '$REMOTE_APP_DIR'" >&2
  exit 1
fi

# Production deploys must be reproducible from the reviewed branch on the deploy
# remote. This catches the two easiest operator mistakes: archiving uncommitted
# work, or deploying a local commit that has not been merged through a pull request.
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
DEPLOY_STAGE="$(mktemp -d /tmp/max-deploy.XXXXXX)"
DEPLOY_ACTIVATED="off"
# The release serving before this deploy, read from /health just before activation; what a rollback must bring back.
PREVIOUS_COMMIT=""
REMOTE_NEXT_DIR=""
REMOTE_PREVIOUS_DIR="${REMOTE_APP_DIR}.previous"
REMOTE_FAILED_DIR=""
cleanup() {
  local exit_status=$?
  if [[ "$exit_status" -ne 0 && "$DEPLOY_ACTIVATED" == "on" ]]; then
    echo "==> Deployment failed after activation; restoring the previous release" >&2
    local rolled_back="on"
    ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
      "set -e; rm -rf '$REMOTE_FAILED_DIR'; mv '$REMOTE_APP_DIR' '$REMOTE_FAILED_DIR'; mv '$REMOTE_PREVIOUS_DIR' '$REMOTE_APP_DIR'; pm2 restart max --update-env; rm -rf '$REMOTE_FAILED_DIR'" \
      || rolled_back="off"
    if [[ "$rolled_back" != "on" ]]; then
      # The release that just failed may still be the one answering: nothing below may call it the previous one.
      echo "Automatic rollback failed; $GIT_COMMIT may still be serving. Inspect $HOST immediately." >&2
    else
      # pm2 restarting is not the previous release serving: wait until /ready reports it, with no issues.
      local restored="off"
      for _ in {1..20}; do
        if curl --fail --silent --connect-timeout 5 --max-time 8 "$READY_URL" 2>/dev/null |
          FAILED_COMMIT="$GIT_COMMIT" PREVIOUS_COMMIT="$PREVIOUS_COMMIT" node -e '
            let body = "";
            process.stdin.on("data", (chunk) => (body += chunk));
            process.stdin.on("end", () => {
              try {
                const ready = JSON.parse(body);
                const build = ready.build?.gitCommit;
                const expected = process.env.PREVIOUS_COMMIT;
                const valid = ready.ok === true && Array.isArray(ready.issues) && ready.issues.length === 0 &&
                  (expected ? build === expected : build !== process.env.FAILED_COMMIT);
                process.exit(valid ? 0 : 1);
              } catch {
                process.exit(1);
              }
            });
          '; then
          restored="on"
          break
        fi
        sleep 2
      done
      if [[ "$restored" == "on" && -n "$PREVIOUS_COMMIT" ]]; then
        echo "==> The previous release ($PREVIOUS_COMMIT) is back and ready." >&2
      elif [[ "$restored" == "on" ]]; then
        # Without the pre-deploy build there is nothing to match: some other build is ready, which one is unproven.
        echo "Rollback UNVERIFIED: a build other than $GIT_COMMIT reports ready at $READY_URL, but which release was serving before this deploy is unknown (its /health gave no build). Check $HOST." >&2
      else
        echo "The previous release was put back but does not report ready${PREVIOUS_COMMIT:+ as $PREVIOUS_COMMIT} at $READY_URL; the site may be down. Inspect $HOST immediately." >&2
      fi
    fi
  fi
  [[ "$DEPLOY_STAGE" == /tmp/max-deploy.* ]] && rm -rf "$DEPLOY_STAGE"
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

# Build the exact archived commit locally, with the packages its own lockfile
# names: a clean install, not this checkout's node_modules, which may belong to
# another commit. The Lightsail instance is deliberately small and can be
# OOM-killed by TypeScript/Vite; it only needs runtime packages.
echo "==> 1/4 Installing the archived commit's packages"
(
  cd "$DEPLOY_STAGE"
  npm ci --no-audit --no-fund --prefer-offline
)
if [[ -n "${TESTING_GATE_URL:-}" ]]; then
  echo "==> Release gate at $TESTING_GATE_URL for $GIT_COMMIT"
  # The gate runs inside the stage, which is deleted afterwards: a relative report path is kept in the checkout.
  if [[ -n "${TESTING_GATE_REPORT:-}" && "$TESTING_GATE_REPORT" != /* ]]; then
    TESTING_GATE_REPORT="$(pwd)/$TESTING_GATE_REPORT"
    export TESTING_GATE_REPORT
  fi
  (
    cd "$DEPLOY_STAGE"
    TESTING_GATE_EXPECTED_BUILD="$GIT_COMMIT" npx --no-install tsx scripts/testing-release-gate.ts
  ) || {
    echo "Release gate refused $GIT_COMMIT (or could not be reached); nothing was deployed." >&2
    exit 1
  }
else
  echo "==> No release gate configured (TESTING_GATE_URL); deploying without live-agent test approval."
fi
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
# Which release is serving now, so a rollback can be checked against it. Unknown (empty) if /health does not say.
PREVIOUS_COMMIT="$(curl --fail --silent --connect-timeout 5 --max-time 8 "$HEALTH_URL" 2>/dev/null |
  node -e 'let b = ""; process.stdin.on("data", (c) => (b += c)); process.stdin.on("end", () => {
    try { const c = JSON.parse(b).build?.gitCommit; if (typeof c === "string") process.stdout.write(c); } catch {}
  });' || true)"
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
