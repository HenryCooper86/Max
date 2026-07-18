#!/bin/bash
# Deploy to the AWS Lightsail test server (see README "Build & Deployment Pipeline").
# Double-click in Finder or run: ./deploy-lightsail.command
set -euo pipefail
cd "$(dirname "$0")"

KEY="${LIGHTSAIL_KEY:-/Users/admin/Desktop/LightsailDefaultKey-ap-northeast-2.pem}"
HOST="${LIGHTSAIL_HOST:-ubuntu@3.35.135.136}"
REMOTE_APP_DIR="${LIGHTSAIL_APP_DIR:-/home/ubuntu/app}"
HEALTH_URL="${LIGHTSAIL_HEALTH_URL:-https://3.35.135.136/health}"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  echo "Fix the KEY path at the top of this script." >&2
  exit 1
fi

# Deploy from a clean snapshot so local build caches, IDE state, and other
# ignored files can never be copied to the server. The temporary directory is
# validated by mktemp before it is registered for recursive cleanup.
DEPLOY_STAGE="$(mktemp -d /tmp/doubao-deploy.XXXXXX)"
cleanup() {
  [[ "$DEPLOY_STAGE" == /tmp/doubao-deploy.* ]] && rm -rf "$DEPLOY_STAGE"
}
trap cleanup EXIT

git archive HEAD | tar -x -C "$DEPLOY_STAGE"

# Stamp the build identity inside the clean snapshot. The server-side client
# build and relay use this file to tag sessions and /health.
GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
printf '{\n  "gitCommit": "%s",\n  "deployedAt": "%s"\n}\n' \
  "$GIT_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEPLOY_STAGE/build-info.json"
echo "==> Build stamp: $GIT_COMMIT"

echo "==> 1/3 Pushing source to $HOST (server .env, node_modules, dist are protected)"
rsync -azc --delete \
  --exclude='.git' --exclude='.env' --exclude='node_modules' \
  --exclude='dist' --exclude='.DS_Store' --exclude='.claude' \
  --exclude='android/.gradle' --exclude='android/.idea' \
  --exclude='android/.kotlin' --exclude='android/local.properties' \
  --exclude='android/app/build' --exclude='ios/build' \
  --exclude='ios/DerivedData' --exclude='ios/MaxHelmet.xcodeproj/xcuserdata' \
  --exclude='ios/MaxHelmet.xcodeproj/project.xcworkspace/xcuserdata' \
  --exclude='ios/MaxHelmet.xcodeproj/project.xcworkspace/xcshareddata' \
  -e "ssh -i '$KEY' -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  "$DEPLOY_STAGE/" "$HOST":"$REMOTE_APP_DIR/"

echo "==> 2/3 Installing deps, rebuilding client, restarting pm2 process 'horizon'"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" \
  "cd '$REMOTE_APP_DIR' && npm install && npm run build && pm2 restart horizon"

echo "==> 3/3 Health check"
sleep 2
curl -fsk "$HEALTH_URL"
echo
echo "Done. Expect: {\"ok\":true,\"provider\":\"doubao\"}"
