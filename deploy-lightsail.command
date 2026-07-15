#!/bin/bash
# Deploy to the AWS Lightsail test server (see README "Build & Deployment Pipeline").
# Double-click in Finder or run: ./deploy-lightsail.command
set -euo pipefail
cd "$(dirname "$0")"

KEY="/Users/cooph2o/Desktop/LightsailDefaultKey-ap-northeast-2.pem"
HOST="ubuntu@3.35.135.136"

if [[ ! -f "$KEY" ]]; then
  echo "SSH key not found: $KEY" >&2
  echo "Fix the KEY path at the top of this script." >&2
  exit 1
fi

# Stamp the build identity before rsync: .git is excluded from the sync, so
# the server-side client build and the relay read this file to tag sessions
# and /health with the deployed commit (see server/build-info.ts).
GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
printf '{\n  "gitCommit": "%s",\n  "deployedAt": "%s"\n}\n' \
  "$GIT_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build-info.json
echo "==> Build stamp: $GIT_COMMIT"

echo "==> 1/3 Pushing source to $HOST (server .env, node_modules, dist are protected)"
rsync -az --delete \
  --exclude='.git' --exclude='.env' --exclude='node_modules' \
  --exclude='dist' --exclude='.DS_Store' \
  -e "ssh -i $KEY" ./ "$HOST":/home/ubuntu/app/

echo "==> 2/3 Installing deps, rebuilding client, restarting pm2 process 'horizon'"
ssh -i "$KEY" "$HOST" 'cd ~/app && npm install && npm run build && pm2 restart horizon'

echo "==> 3/3 Health check"
sleep 2
curl -sk https://3.35.135.136/health
echo
echo "Done. Expect: {\"ok\":true,\"provider\":\"doubao\"}"
