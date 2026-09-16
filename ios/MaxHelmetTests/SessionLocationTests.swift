import CoreLocation
import XCTest
@testable import MaxHelmet

final class SessionLocationTests: XCTestCase {
    func testOldAndImpreciseCachedFixesCannotBecomeCurrentLocation() {
        let now = Date()
        func fix(age: Double, accuracy: Double) -> CLLocation {
            CLLocation(coordinate: .init(latitude: 31.23, longitude: 121.47), altitude: 0,
                horizontalAccuracy: accuracy, verticalAccuracy: 1, timestamp: now.addingTimeInterval(-age))
        }
        XCTAssertTrue(LocationProvider.isFresh(fix(age: 1, accuracy: 10), now: now))
        XCTAssertFalse(LocationProvider.isFresh(fix(age: 600, accuracy: 10), now: now))
        XCTAssertFalse(LocationProvider.isFresh(fix(age: 1, accuracy: 5000), now: now))
        XCTAssertFalse(LocationProvider.isFresh(fix(age: 1, accuracy: -1), now: now))
    }
}
