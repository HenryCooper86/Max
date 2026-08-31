# Task 15 fix round 5 report: terminal transport and transaction finalizers

## Scope

- Review base: `485c905426edf2d945e3387d47b083c6568a47d3`
- Review: `task-15-review-5.md`
- Test-only RED: `f118947` (`test(ios-companion): cover terminal transaction finalizers`)
- Round-five production changes are limited to `ios/MaxHelmet/Companion/RDKCompanionClient.swift` and `ios/MaxHelmet/UI/MainViewModel.swift`; regression coverage is limited to their existing Task 13/15 test files. Task 16, server/RDK source, settings, plists, README, voice behavior, map/Amap, location persistence, and the public MainViewModel interface are unchanged.

## Review verification and RED

The three review roots were reproduced against unchanged `485c905` production before edits. The exact command ran from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test \
  -project MaxHelmet.xcodeproj \
  -scheme MaxHelmet \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:MaxHelmetTests/CompanionViewModelTests \
  -only-testing:MaxHelmetTests/CompanionSettingsTests \
  -only-testing:MaxHelmetTests/RDKCompanionClientTests
```

The committed strict RED exited 65 after executing 133 focused tests: 126 passed and seven new/updated regression methods failed with 38 intended assertions. There was no compiler, fixture, simulator-selection, or unrelated failure:

- A joined Unpair plus logout/account boundary was stranded when Stop transport failure published ordinary connection failure before its result callback, or when auth/unpaired arrived during the synchronous location-Stop phase.
- A valid fresh Start reentered during ordinary location Stop or while the Stop completion was pending could invalidate the only client callback that released the old ViewModel teardown phase. Later logout/account replacement then waited forever.
- Server auth/unpaired invalidated action completions but retained the socket, receive loop, and rejected account configuration through observable publication. HTTP 401 also allowed callback Start to reopen the rejected account.

The RED matrices include repeated Stop completion, paired auth/unpaired terminal forms, nested B to C/clear account intents, Start reentry from both ordinary Stop boundaries, late receive/send error and duplicate frame delivery, reentrant public Start, and a passing reentrant explicit-Connect replacement control.

## Implementation

- `RDKCompanionClient` now retires an authoritative server-terminal transport before publishing it: it advances connection generation, clears the account configuration and open/reconnect ownership, resets the receive pump, drops ride/location/action work, removes the current socket, and cancels that socket exactly once.
- A callback Start after auth/unpaired therefore has no retained configuration or socket to reuse. Only an explicit `connect` can create a new generation; a `connect` reentered directly from terminal publication remains authoritative after the old handler unwinds.
- Delayed or duplicate receive/send work from the retired generation fails the generation/receive/action guards and cannot replace terminal truth or schedule reconnect. HTTP 401 also clears configuration/open ownership before publishing auth, preventing old-account callback reopen.
- `MainViewModel` treats an interrupted joined Unpair phase as an explicit transaction exit. During `.stoppingLocation`, auth/unpaired/failure publication preserves the owner long enough for the required companion Stop attempt. During `.stoppingCompanion`, failure or terminal publication finalizes the joined account boundary immediately because the Stop was already attempted and its client completion may be invalidated.
- Joined finalization cancels Unpair without clearing pair code, performs one Disconnect, and releases logout/token transition ownership exactly once. Repeated old Stop results are stale; newest nested B/C/clear token intent drains after the boundary.
- A validated fresh Start explicitly settles any old ordinary ride teardown before advancing generation and connecting. Invalid Start requests do not settle it. The new ride can remain authoritative, while a later logout/account replacement independently stops that new location/client ride instead of waiting for an obsolete callback.

## GREEN and broad verification

- Exact focused Task 15 plus affected Task 13 command: exit 0; 133 tests, 0 failures; `** TEST SUCCEEDED **`.
- Full `MaxHelmet` suite on exact `iPhone 17`: exit 0; 380 tests, 0 failures; `** TEST SUCCEEDED **`.
- Fresh unsigned Debug iPhone 17 build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Fresh unsigned Release generic-simulator build with isolated DerivedData: exit 0; `** BUILD SUCCEEDED **`.
- Source and both final built plists pass `plutil -lint`. Built Debug contains exactly `audio, location` and `NSAllowsArbitraryLoads = true`; built Release contains exactly `audio, location`, `NSAllowsLocalNetworking = true`, and no arbitrary-load exception.
- Both source location usage descriptions remain identical and explicitly name precise location, RDK helmet navigation, explicit Helmet Ride, and locked-screen forwarding.
- Cumulative `git diff --check bffe82e`: exit 0. Round-five scope contains only the client, ViewModel, their two existing test files, and this report.
- Scoped source/privacy checks found no map/Amap dependency, token/coordinate/fix/pair-code logging or persistence, manual-token companion authentication, plist/README change, server/RDK/Task 16 source, or public product-interface widening.

## Adversarial audit

- Joined Unpair crossed with logout, replacement, nested B/C/clear, Stop failure, auth/unpaired from location Stop, duplicate result, and queued Start performs one location Stop, one required companion Stop attempt, one Disconnect, no Unpair, and retains pair code.
- Ordinary Stop crossed with a fresh Start from location Stop or a pending Stop completion releases the old phase without relying on that old client result. Subsequent logout or delayed account Stop finishes coherently; obsolete success/failure duplicates cannot overwrite the newest state.
- Server auth/unpaired cancels its socket and receive ownership before callback observation. Reentrant Start is inert until explicit Connect; explicit reentrant Connect owns the replacement; late old receive/send results and duplicate terminal/ready frames remain stale.
- HTTP 401 similarly prevents rejected-account callback reopen. Non-auth transient connection recovery, pair-only owned Unpair completion, throttle ownership, permission behavior, account-session-token-only auth, no login/relaunch auto-start, and hands-free independence remain green.

## Remaining concerns

- Physical locked-screen duration, the system location indicator, force-quit behavior, and real RDK reception remain Task 16 acceptance work.
- Xcode continues to print existing unrelated Swift concurrency warnings. The full suite also prints the known non-fatal post-success diagnostic-collector `simctl` warning; all required verification commands exit 0.
