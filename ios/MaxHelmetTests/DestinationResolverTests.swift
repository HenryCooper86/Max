import CoreLocation
import XCTest
@testable import MaxHelmet

private final class FakeSearch: RouteSearching, @unchecked Sendable {
    var destination: Destination?
    func search(_ query: String) async -> Destination? { destination }
}

final class DestinationResolverTests: XCTestCase {

    private let tiananmen = Destination(
        name: "天安门",
        coordinate: CLLocationCoordinate2D(latitude: 39.9087, longitude: 116.3975),
        distanceMeters: 12_400,
        etaSeconds: 1_500
    )

    func testPublishesAResolvedDestination() async {
        let search = FakeSearch()
        search.destination = tiananmen
        var published: Destination?
        let handler = DestinationResolver(search: search, onResolved: { published = $0 })

        let result = await handler.perform(.destinationShow(query: "天安门"))

        XCTAssertEqual(result, .ok)
        XCTAssertEqual(published, tiananmen)
    }

    func testReportsAnUnresolvableDestination() async {
        let search = FakeSearch()
        search.destination = nil
        let handler = DestinationResolver(search: search, onResolved: { _ in })

        let result = await handler.perform(.destinationShow(query: "火星"))

        XCTAssertEqual(result.status, .unsupported)
        XCTAssertEqual(result.reason, "route.unavailable")
    }

    func testSummaryStatesDistanceAndTimeWithoutPromisingGuidance() {
        let summary = destinationSummary(tiananmen)

        XCTAssertTrue(summary.contains("天安门"))
        XCTAssertTrue(summary.contains("12.4"))
        XCTAssertTrue(summary.contains("25"))
        XCTAssertFalse(summary.contains("导航中"), "The card must not imply turn-by-turn guidance")
    }
}
