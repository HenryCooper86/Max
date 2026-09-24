import XCTest
@testable import MaxHelmet

final class CompanionSettingsTests: XCTestCase {
    func testPairCodeFilterKeepsOnlySixASCIIDigits() {
        XCTAssertEqual(CompanionSettingsPresentation.filteredPairCode("１２a3-456789"), "345678")
        XCTAssertEqual(CompanionSettingsPresentation.filteredPairCode(" 001234 "), "001234")
    }

    func testConnectionCopyAndActionsCoverEveryProductStateWithoutEchoingServerDetail() {
        let hostile = "account-token 31.2304,121.4737 course=99 speed=8"
        let cases: [(CompanionConnectionState, String, Bool, Bool)] = [
            (.signedOut, "请先登录账号", false, false),
            (.connecting, "正在连接 RDK 头盔…", false, false),
            (.unpaired, "尚未配对", true, false),
            (.paired(deviceId: "secret-device", label: "Helmet"), "已配对，等待开始骑行", false, true),
            (.helmetOffline(deviceId: nil, label: nil), "已配对，头盔离线", false, true),
            (.ready(deviceId: nil, label: nil), "RDK 头盔已连接", false, true),
            (.sharing(deviceId: nil, label: nil), "正在向 RDK 头盔转发导航位置", false, true),
            (.failed(code: "auth", detail: hostile), "账号会话已失效，请重新登录", false, false),
            (.failed(code: "connection", detail: hostile), "RDK 头盔连接失败，请重试", true, false)
        ]

        for (state, status, pairEnabled, showsUnpair) in cases {
            let model = CompanionSettingsPresentation.make(
                isLoggedIn: state != .signedOut,
                pairCode: "123456",
                connectionState: state,
                rideOwned: false,
                permission: .notDetermined,
                lastForwardedAt: nil,
                now: Date(timeIntervalSince1970: 100)
            )
            XCTAssertEqual(model.statusText, status, "state \(state)")
            XCTAssertEqual(model.isPairEnabled, pairEnabled, "state \(state)")
            XCTAssertEqual(model.showsUnpair, showsUnpair, "state \(state)")
            XCTAssertFalse(model.renderedStrings.joined(separator: " ").contains(hostile))
            XCTAssertFalse(model.renderedStrings.joined(separator: " ").contains("secret-device"))
        }
    }

    func testPermissionCopyDistinguishesNotDeterminedDeniedReducedAndPrecise() {
        let cases: [(CompanionLocationPermission, String)] = [
            (.notDetermined, "位置权限将在开始 Helmet Ride 时请求"),
            (.denied, "位置权限已拒绝，请在系统设置中允许使用位置"),
            (.reduced, "位置精度不足，请在系统设置中开启精确位置"),
            (.precise, "精确位置可用")
        ]
        for (permission, expected) in cases {
            XCTAssertEqual(model(permission: permission).permissionText, expected)
        }
    }

    // Bench 2026-08-12: a board power-cut left a paired phone in
    // .failed(code: "connection") — the companion socket is ride-scoped, so it
    // never retries on its own. The panel then said "请重试" while disabling the
    // only control that retries, leaving re-pairing as the sole way forward.
    func testConnectionFailureLeavesTheRideRetryable() {
        let failed = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .failed(code: "connection", detail: "Companion connection closed."),
            rideOwned: false,
            permission: .precise,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertEqual(failed.statusText, "RDK 头盔连接失败，请重试")
        XCTAssertTrue(failed.isPrimaryActionEnabled, "‘请重试’ needs a control that actually retries")
        XCTAssertEqual(failed.primaryActionTitle, "开始 Helmet Ride")
    }

    func testAuthFailureStillOffersNoRideRetry() {
        let failed = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .failed(code: "auth", detail: "expired"),
            rideOwned: false,
            permission: .precise,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertFalse(failed.isPrimaryActionEnabled, "a dead account session must be fixed by logging in")
    }

    func testPrimaryActionPairingAndUnpairAvailabilityAreTruthful() {
        let paired = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .paired(deviceId: nil, label: nil),
            rideOwned: false,
            permission: .precise,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertEqual(paired.primaryActionTitle, "开始 Helmet Ride")
        XCTAssertTrue(paired.isPrimaryActionEnabled)
        XCTAssertFalse(paired.isPairEnabled, "an already-paired helmet cannot start another pairing action")
        XCTAssertTrue(paired.showsUnpair)
        XCTAssertTrue(paired.isUnpairEnabled)

        let offline = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .helmetOffline(deviceId: nil, label: nil),
            rideOwned: false,
            permission: .precise,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertFalse(offline.isPrimaryActionEnabled)

        let activeDenied = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .failed(code: "permission", detail: "ignored"),
            rideOwned: true,
            permission: .denied,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertEqual(activeDenied.primaryActionTitle, "停止 Helmet Ride")
        XCTAssertTrue(activeDenied.isPrimaryActionEnabled, "an owned degraded ride must remain stoppable")
        XCTAssertFalse(activeDenied.isPairEnabled)
        XCTAssertFalse(activeDenied.isUnpairEnabled)

        let busy = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .connecting,
            rideOwned: false,
            permission: .precise,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertFalse(busy.isPairEnabled)
        XCTAssertFalse(busy.isPrimaryActionEnabled)
    }

    func testDiscoveryPairGateDropsTheExactCodeRequirementButSharesEveryOtherGuardWithManualPair() {
        let shortManualCode = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "12",
            connectionState: .unpaired,
            rideOwned: false,
            permission: .notDetermined,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertFalse(shortManualCode.isPairEnabled, "a non-six-digit manual code must not enable manual pairing")
        XCTAssertTrue(
            shortManualCode.isPairEnabledForDiscovery,
            "a discovered helmet's token stands in for the code, so the manual field's contents must not gate it"
        )

        let rideAlreadyOwned = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "123456",
            connectionState: .unpaired,
            rideOwned: true,
            permission: .notDetermined,
            lastForwardedAt: nil,
            now: Date()
        )
        XCTAssertFalse(rideAlreadyOwned.isPairEnabled)
        XCTAssertFalse(
            rideAlreadyOwned.isPairEnabledForDiscovery,
            "a shared gate (an owned ride) must disable both pairing paths identically"
        )
    }

    func testForwardedAgeIsDeterministicBoundedAndAbsentCopyIsExplicit() {
        let now = Date(timeIntervalSince1970: 1_000)
        let absent = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "",
            connectionState: .ready(deviceId: nil, label: nil),
            rideOwned: false,
            permission: .precise,
            lastForwardedAt: nil,
            now: now
        )
        XCTAssertEqual(absent.forwardingText, "尚未转发位置")

        let recent = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "",
            connectionState: .sharing(deviceId: nil, label: nil),
            rideOwned: true,
            permission: .precise,
            lastForwardedAt: Date(timeIntervalSince1970: 995.2),
            now: now
        )
        XCTAssertEqual(recent.forwardingText, "上次转发：4 秒前")

        let clockRollback = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "",
            connectionState: .sharing(deviceId: nil, label: nil),
            rideOwned: true,
            permission: .precise,
            lastForwardedAt: Date(timeIntervalSince1970: 1_100),
            now: now
        )
        XCTAssertEqual(clockRollback.forwardingText, "上次转发：0 秒前")
    }

    func testRenderedStringsNeverContainRawFixTokenMotionOrHostileDetailSentinels() {
        let sentinels = ["TOKEN_SENTINEL", "31.2304", "121.4737", "COURSE_SENTINEL", "SPEED_SENTINEL"]
        let presentation = CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "654321",
            connectionState: .failed(code: "server", detail: sentinels.joined(separator: " ")),
            rideOwned: false,
            permission: .reduced,
            lastForwardedAt: Date(timeIntervalSince1970: 5),
            now: Date(timeIntervalSince1970: 10)
        )
        let rendered = presentation.renderedStrings.joined(separator: " ")
        for sentinel in sentinels { XCTAssertFalse(rendered.contains(sentinel)) }
        XCTAssertFalse(rendered.contains("654321"), "pair code is input state, not presentation/status copy")
    }

    func testSettingsSourceConsumesPurePresentationAndUsesNormalSectionNumberPadAndConfirmation() throws {
        let source = try String(contentsOf: iosRoot.appendingPathComponent("MaxHelmet/UI/AgentSettingsPanel.swift"))
        XCTAssertTrue(source.contains("SectionCard(title: \"RDK 头盔\")"))
        XCTAssertTrue(source.contains("CompanionSettingsPresentation.make"))
        XCTAssertTrue(source.contains(".keyboardType(.numberPad)"))
        XCTAssertTrue(source.contains(".confirmationDialog"))
        XCTAssertTrue(source.contains("viewModel.unpairHelmet()"))
        XCTAssertFalse(source.contains("Map("))
    }

    func testBothPlistsDeclareOnlyAudioAndLocationWithIdenticalRiderFacingUsageAndNarrowATS() throws {
        let release = try plist(named: "Info.plist")
        let debug = try plist(named: "Info-Debug.plist")
        let expectedModes = ["audio", "location"]
        XCTAssertEqual(release["UIBackgroundModes"] as? [String], expectedModes)
        XCTAssertEqual(debug["UIBackgroundModes"] as? [String], expectedModes)

        let releaseUsage = try XCTUnwrap(release["NSLocationWhenInUseUsageDescription"] as? String)
        let debugUsage = try XCTUnwrap(debug["NSLocationWhenInUseUsageDescription"] as? String)
        XCTAssertEqual(releaseUsage, debugUsage)
        let motionUsage = try XCTUnwrap(release["NSMotionUsageDescription"] as? String)
        XCTAssertEqual(debug["NSMotionUsageDescription"] as? String, motionUsage)
        XCTAssertTrue(releaseUsage.contains("RDK 头盔导航"))
        XCTAssertTrue(releaseUsage.contains("锁屏"))
        XCTAssertTrue(releaseUsage.contains("Helmet Ride"))

        let releaseATS = try XCTUnwrap(release["NSAppTransportSecurity"] as? [String: Any])
        let debugATS = try XCTUnwrap(debug["NSAppTransportSecurity"] as? [String: Any])
        XCTAssertNil(releaseATS["NSAllowsArbitraryLoads"])
        XCTAssertEqual(debugATS["NSAllowsArbitraryLoads"] as? Bool, true)
    }

    func testReadmeDocumentsExplicitLifecycleTokenPermissionTLSForceQuitAndPrivacyOperations() throws {
        let readme = try String(contentsOf: iosRoot.appendingPathComponent("README.md"))
        let required = [
            "六位配对码", "开始 Helmet Ride", "停止 Helmet Ride", "取消配对", "退出登录",
            "账号会话令牌", "手动操作员令牌", "使用 App 期间", "精确位置", "锁屏",
            "位置指示器", "强制退出", "不会自动恢复", "Debug", "自签名", "生产", "受信任证书",
            "不显示地图", "不显示原始坐标", "不持久化位置"
        ]
        for phrase in required { XCTAssertTrue(readme.contains(phrase), "missing README operation: \(phrase)") }
    }

    private func model(permission: CompanionLocationPermission) -> CompanionSettingsPresentation {
        CompanionSettingsPresentation.make(
            isLoggedIn: true,
            pairCode: "",
            connectionState: .ready(deviceId: nil, label: nil),
            rideOwned: false,
            permission: permission,
            lastForwardedAt: nil,
            now: Date()
        )
    }

    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func plist(named name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("MaxHelmet/\(name)"))
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any]
        )
    }
}
