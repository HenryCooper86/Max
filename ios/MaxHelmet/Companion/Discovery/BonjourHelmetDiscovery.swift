import Network

/// Browses `_maxhelmet._tcp` and surfaces one `DiscoveredHelmet` per beacon
/// token. Scan lifetime is owned by the pairing screen: `start()` on appear,
/// `stop()` on disappear — no background radio use.
final class BonjourHelmetDiscovery: HelmetDiscovering {
    var onUpdate: (([DiscoveredHelmet]) -> Void)?
    private var browser: NWBrowser?

    /// Parses the beacon's TXT record. Only `dt` (the 32-lowercase-hex
    /// discovery token) matters here — `v` is read by nothing yet, reserved
    /// for a future protocol bump.
    static func token(fromTxt txt: [String: String]) -> String? {
        guard let value = txt["dt"], value.count == 32,
              value.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }) else {
            return nil
        }
        return value
    }

    func start() {
        stop()
        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_maxhelmet._tcp", domain: nil)
        let browser = NWBrowser(for: descriptor, using: .tcp)
        // NWBrowser.cancel() tears down asynchronously — a results callback
        // already queued at cancel time (or from a since-replaced browser)
        // can still land afterward. Compare identity against the currently
        // owned browser so a stale or superseded callback is dropped instead
        // of resurrecting cleared/old results.
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
            guard let browser, self?.browser === browser else { return }
            let helmets = results.compactMap { result -> DiscoveredHelmet? in
                guard case let .bonjour(record) = result.metadata,
                      let token = Self.token(fromTxt: record.dictionary) else {
                    return nil
                }
                return DiscoveredHelmet(token: token, transport: "mdns")
            }
            self?.onUpdate?(DiscoveredHelmet.merged(helmets))
        }
        self.browser = browser
        browser.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        onUpdate?([])
    }
}
