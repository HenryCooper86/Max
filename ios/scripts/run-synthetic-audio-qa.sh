#!/bin/bash
# Opt-in native integration against a configured real relay. Credentials remain
# in the private input directory; never pass tokens in argv or print them.
set -euo pipefail
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
task_dir="${MAX_SYNTHETIC_QA_DIR:-/tmp/max-synthetic-qa}"
derived_dir="${MAX_SYNTHETIC_QA_DERIVED_DATA:-/tmp/max-ios-synthetic-dd}"
device_id="${MAX_SYNTHETIC_QA_SIMULATOR:-F07CDA1E-E25C-4AAC-A3E8-145EA9A977B7}"
repeats="${MAX_SYNTHETIC_QA_REPEATS:-2}"
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
source_commit="$(git -C "$repo_dir" rev-parse HEAD)"
source_build="$(git -C "$repo_dir" rev-parse --short=12 HEAD)"
test_target="${MAX_SYNTHETIC_QA_TEST_TARGET:-MaxHelmetTests/SyntheticAudioLiveTests}"
mkdir -p "$task_dir"
chmod 700 "$task_dir"
test -f "$task_dir/connection.json"
test -f "$task_dir/manifest.json"
chmod 600 "$task_dir/connection.json"
stamp="$(date +%Y%m%d-%H%M%S)"
xcodebuild build-for-testing -workspace "$repo_dir/ios/MaxHelmet.xcworkspace" \
  -scheme MaxHelmet -configuration Debug -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$derived_dir" "HORIZON_GIT_COMMIT=$source_build" \
  > "$task_dir/ios-build-$stamp.log" 2>&1
python3 - "$derived_dir" "$task_dir" "$repeats" "$repo_dir" "$source_commit" <<'PY'
import glob,hashlib,os,plistlib,sys
root,private,repeats,repo,source_commit=sys.argv[1:]
paths=['ios/MaxHelmet/Agent/AgentSession.swift','ios/MaxHelmet/Agent/MicStreamer.swift','ios/MaxHelmet/Agent/PcmPlayer.swift','ios/MaxHelmetTests/SyntheticAudioLiveTests.swift','ios/scripts/run-synthetic-audio-qa.sh']
fingerprint=hashlib.sha256()
for path in paths:
    fingerprint.update(path.encode()+b'\0'+open(os.path.join(repo,path),'rb').read()+b'\0')
overlay_revision=fingerprint.hexdigest()
source=glob.glob(os.path.join(root,'Build/Products/MaxHelmet_*.xctestrun'))[0]
data=plistlib.load(open(source,'rb'))
for configuration in data['TestConfigurations']:
    for target in configuration['TestTargets']:
        for key in ('EnvironmentVariables','TestingEnvironmentVariables'):
            target.setdefault(key,{}).update(MAX_SYNTHETIC_QA='1', MAX_SYNTHETIC_QA_DIR=private, MAX_SYNTHETIC_QA_REPEATS=repeats, MAX_SYNTHETIC_QA_BASE_SOURCE_COMMIT=source_commit, MAX_SYNTHETIC_QA_OVERLAY_REVISION=overlay_revision)
plistlib.dump(data,open(os.path.join(root,'Build/Products/SyntheticQA.xctestrun'),'wb'))
PY
xcodebuild test-without-building -xctestrun "$derived_dir/Build/Products/SyntheticQA.xctestrun" \
  -destination "platform=iOS Simulator,id=$device_id" -parallel-testing-enabled NO \
  "-only-testing:$test_target" -resultBundlePath "$task_dir/ios-live-$stamp.xcresult" \
  > "$task_dir/ios-live-$stamp.log" 2>&1
printf 'Native synthetic QA completed; private evidence: %s/ios-results\n' "$task_dir"
