import CoreLocation
import XCTest
@testable import MaxHelmet

final class NavigationLocalizationTests: XCTestCase {
    private func parseRoute(_ steps: String) -> NavRouteData? {
        let json = """
        {"type":"nav.route","commandId":"n1","destinationName":"A","destination":{"lat":31.24,"lon":121.47},
         "distanceMeters":1109,"etaSeconds":240,
         "polyline":[{"lat":31.23,"lon":121.47},{"lat":31.235,"lon":121.47},{"lat":31.24,"lon":121.47}],
         "steps":\(steps)}
        """
        if case let .navRoute(route) = parseAgentEvent(json) { return route }
        return nil
    }

    func testDecodesWithAndWithoutLocalizedInstruction() throws {
        let with = try XCTUnwrap(parseRoute(#"[{"instruction":"右转进入南京东路","localizedInstruction":"Turn right onto 南京东路","lat":31.235,"lon":121.47,"alongRouteMeters":555}]"#))
        XCTAssertEqual(with.steps[0].instruction, "右转进入南京东路")
        XCTAssertEqual(with.steps[0].localizedInstruction, "Turn right onto 南京东路")
        XCTAssertEqual(with.steps[0].displayInstruction, "Turn right onto 南京东路")

        let without = try XCTUnwrap(parseRoute(#"[{"instruction":"右转","lat":31.235,"lon":121.47,"alongRouteMeters":555}]"#))
        XCTAssertNil(without.steps[0].localizedInstruction)
        XCTAssertEqual(without.steps[0].displayInstruction, "右转")

        let empty = try XCTUnwrap(parseRoute(#"[{"instruction":"右转","localizedInstruction":"","lat":31.235,"lon":121.47,"alongRouteMeters":555}]"#))
        XCTAssertNil(empty.steps[0].localizedInstruction)
    }

    private func route(localized: Bool) -> NavigationRoute {
        func step(_ zh: String, _ en: String?, _ lat: Double, _ along: Double) -> ManeuverStep {
            ManeuverStep(instruction: zh, coordinate: CLLocationCoordinate2D(latitude: lat, longitude: 121.47),
                         alongRouteMeters: along, localizedInstruction: localized ? en : nil)
        }
        return NavigationRoute(
            destinationName: "终点",
            destinationCoordinate: CLLocationCoordinate2D(latitude: 31.24, longitude: 121.47),
            polyline: [31.23, 31.235, 31.24].map { CLLocationCoordinate2D(latitude: $0, longitude: 121.47) },
            steps: [step("右转进入南京东路", "Turn right onto 南京东路", 31.235, 555),
                    step("到达终点", "You have arrived", 31.24, 1109)],
            totalDistanceMeters: 1109, totalEtaSeconds: 240)
    }

    private func firstPrompt(_ route: NavigationRoute, lat: Double) -> GuidanceUpdate {
        GuidanceEngine.step(
            position: CLLocationCoordinate2D(latitude: lat, longitude: 121.47), route: route,
            progress: GuidanceProgress(maneuverIndex: 0, firedThresholds: [], arrived: false))
    }

    func testEnglishLeadInAndUnchangedChineseWording() {
        // ~200 m before the turn at 555 m along the route.
        let en = firstPrompt(route(localized: true), lat: 31.2332)
        XCTAssertEqual(en.spokenPrompt, "In 200 metres, turn right onto 南京东路")
        XCTAssertEqual(en.currentInstruction, "Turn right onto 南京东路")
        XCTAssertEqual(en.currentOriginalInstruction, "右转进入南京东路")

        let zh = firstPrompt(route(localized: false), lat: 31.2332)
        XCTAssertEqual(zh.spokenPrompt, "前方200米，右转进入南京东路", "no localized instruction: today's Chinese, exactly")
        XCTAssertEqual(zh.currentInstruction, "右转进入南京东路")
    }

    func testLeadInHelper() {
        let step = ManeuverStep(instruction: "掉头", coordinate: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                                alongRouteMeters: 0, localizedInstruction: "Make a U-turn")
        XCTAssertEqual(leadIn(step: step, now: false, meters: 50), "In 50 metres, make a U-turn")
        XCTAssertEqual(leadIn(step: step, now: true, meters: 0), "Make a U-turn")
        let plain = ManeuverStep(instruction: "掉头", coordinate: CLLocationCoordinate2D(latitude: 0, longitude: 0), alongRouteMeters: 0)
        XCTAssertEqual(leadIn(step: plain, now: false, meters: 50), "前方50米，掉头")
        XCTAssertEqual(leadIn(step: plain, now: true, meters: 0), "掉头")
    }

    func testSymbolStillComesFromTheOriginalInstruction() {
        let en = firstPrompt(route(localized: true), lat: 31.2332)
        // The English text would also match "right"; the original is what is parsed.
        XCTAssertEqual(navigationManeuverSymbol(en.currentOriginalInstruction ?? ""), "arrow.turn.up.right")
        var state = GuidanceState(destinationName: "A", polyline: [], currentLocation: nil,
                                  maneuverInstruction: "Turn onto 南京东路", distanceToManeuverMeters: 1,
                                  remainingDistanceMeters: 1, remainingSeconds: 1, offRoute: false)
        state.maneuverOriginalInstruction = "左转进入南京东路"
        XCTAssertEqual(navigationManeuverSymbol(state.maneuverOriginalInstruction ?? state.maneuverInstruction ?? ""), "arrow.turn.up.left")
    }

    func testStepDetailsDisplayLocalizedText() {
        let details = navigationStepDetails(route: route(localized: true), index: 0, remainingMeters: 1109)
        XCTAssertEqual(details.map(\.step.displayInstruction), ["Turn right onto 南京东路", "You have arrived"])
        XCTAssertEqual(details.map(\.step.instruction), ["右转进入南京东路", "到达终点"])
    }

    func testClientComposedNavigationSpeechFollowsTheLanguage() {
        XCTAssertEqual(Loc.string("nav.offRoute", .en), "You're off the route. Recalculating.")
        XCTAssertEqual(Loc.string("nav.rerouteFailed", .en), "I couldn't find a new route. Navigation has stopped.")
        XCTAssertEqual(Loc.string("nav.arrived", .en), "You have arrived.")
        XCTAssertEqual(Loc.string("nav.locationLost", .en), "The phone's location dropped out. Navigation is paused.")
        XCTAssertEqual(Loc.string("nav.confirmSpoken", .en, ["dest": "A"]),
                       "Confirm the destination: A. Say “confirm navigation” or tap Confirm to start turn-by-turn guidance.")
        XCTAssertEqual(Loc.string("nav.offRoute", .zh), "已偏离路线，正在重新规划。")
        XCTAssertEqual(Loc.string("nav.confirmSpoken", .zh, ["dest": "A"]), "请确认目的地：A。确认后开始导航。")
    }

    func testHazardSpeechAndVoiceSelectionFollowTheText() {
        XCTAssertEqual(speechVoiceLanguage(for: "Vehicle approaching fast from behind. Hold your lane."), "en-US")
        XCTAssertEqual(speechVoiceLanguage(for: "后方车辆高速接近。保持车道。"), "zh-CN")
        XCTAssertEqual(speechVoiceLanguage(for: "Turn right onto 南京东路"), "zh-CN", "any Han character selects the Chinese voice")
        XCTAssertEqual(speechVoiceLanguage(for: ""), "en-US")
        // An English-session alert is displayed as received and spoken from its own text.
        let event = parseAgentEvent(#"""
        {"type":"hazard.alert","threat":"vehicle","direction":"left_rear","severity":"critical","label":"Fast vehicle behind",
         "message":"A vehicle is closing in fast.","advice":"Hold your lane.","ttcSeconds":3,"interrupt":true}
        """#)
        guard case let .hazardAlert(alert) = event else { return XCTFail("expected hazardAlert, got \(event)") }
        XCTAssertEqual(alert.label, "Fast vehicle behind")
        XCTAssertEqual(speechVoiceLanguage(for: "\(alert.message) \(alert.advice)"), "en-US")
        XCTAssertEqual(Loc.string("hazard.dir." + alert.direction, .en), "Rear left")
        XCTAssertEqual(Loc.string("hazard.dir.right_rear", .en), "Rear right")
        XCTAssertEqual(Loc.string("hazard.dir.rear", .en), "Behind")
        XCTAssertEqual(Loc.string("hazard.dir.front", .en), "Ahead")
    }
}
