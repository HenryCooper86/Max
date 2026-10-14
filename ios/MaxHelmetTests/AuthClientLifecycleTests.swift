import XCTest
@testable import MaxHelmet

@MainActor
final class AuthClientLifecycleTests: XCTestCase {
    /// An unused login client is common when the HUD is opened/closed without
    /// signing in. Releasing it must not construct a session with a dead delegate.
    func testUnusedClientCanBeReleasedWithoutCreatingSessionDuringDeinit() async throws {
        weak var released: AuthClient?
        autoreleasepool {
            let client = AuthClient()
            released = client
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertNil(released)
    }
}
