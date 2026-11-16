import Foundation

/// One selectable voice backend advertised by the relay's `/health`.
struct VoiceProviderInfo: Equatable, Identifiable {
    let id: String
    let label: String
    /// "demo" | "live" | "pipeline" (kept as the wire string so new kinds degrade gracefully).
    let kind: String
    let configured: Bool
    let description: String?
}

/// `/health.voice`: which backend is active and whether the rider may switch.
struct VoiceHealth: Equatable {
    let active: String
    let switching: Bool
    let providers: [VoiceProviderInfo]

    var activeLabel: String {
        providers.first(where: { $0.id == active })?.label ?? active
    }
}

/// The optional branding + voice sections of the relay `/health` JSON. Every
/// field is optional; a relay that predates them parses to an empty value.
struct RelayHealth: Equatable {
    var branding = AssistantBranding()
    var voice: VoiceHealth?
}

/// Best-effort `GET /health` against the relay base URL (same ws→http
/// derivation and self-signed opt-in as `AuthClient`). Failures are silent:
/// the caller simply keeps its defaults.
final class RelayHealthClient: NSObject {
    private var allowSelfSigned = false
    private var sessionStorage: URLSession?
    private var session: URLSession {
        if let sessionStorage { return sessionStorage }
        let created = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        sessionStorage = created
        return created
    }

    deinit {
        sessionStorage?.finishTasksAndInvalidate()
    }

    /// The completion runs on the main thread, only on success.
    func fetch(relayURL: String, allowSelfSignedTls: Bool, completion: @escaping (RelayHealth) -> Void) {
        guard let base = AuthClient.authBaseURL(fromRelay: relayURL) else { return }
        allowSelfSigned = allowSelfSignedTls
        var request = URLRequest(url: base.appendingPathComponent("health"))
        request.httpMethod = "GET"
        request.timeoutInterval = 6
        session.dataTask(with: request) { data, response, _ in
            guard let data,
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false,
                  let health = Self.parse(data: data) else { return }
            DispatchQueue.main.async { completion(health) }
        }.resume()
    }

    /// What `/brand/logo` returned.
    enum LogoResult: Equatable {
        case png(Data)
        /// SVG (or anything else): not renderable natively; use the bundled mark.
        case unsupported
    }

    /// Resolves a relay-served logo path against the relay origin. Only a plain
    /// absolute path on the relay is accepted (never another host).
    static func logoURL(base: URL, path: String) -> URL? {
        let p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard p.hasPrefix("/"), !p.hasPrefix("//"), !p.contains("\\") else { return nil }
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)
        guard let q = URLComponents(string: "http://x" + p) else { return nil }
        comps?.path = q.path
        comps?.percentEncodedQuery = q.percentEncodedQuery
        return comps?.url
    }

    static let pngSignature: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
    static let maxLogoBytes = 2_000_000

    /// Classifies a logo response by Content-Type, then verifies the PNG magic.
    static func classifyLogo(contentType: String?, data: Data) -> LogoResult {
        let type = (contentType ?? "").split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
        guard type == "image/png", data.count <= maxLogoBytes,
              Array(data.prefix(4)) == pngSignature else { return .unsupported }
        return .png(data)
    }

    /// Best-effort GET of the owner's logo with the same relay base-URL and TLS
    /// handling as `fetch`. Completion on main; failures are silent (no call).
    func fetchLogo(relayURL: String, allowSelfSignedTls: Bool, path: String, completion: @escaping (LogoResult) -> Void) {
        guard let base = AuthClient.authBaseURL(fromRelay: relayURL),
              let url = Self.logoURL(base: base, path: path) else { return }
        allowSelfSigned = allowSelfSignedTls
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        session.dataTask(with: request) { data, response, _ in
            guard let data, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return }
            let result = Self.classifyLogo(contentType: http.value(forHTTPHeaderField: "Content-Type"), data: data)
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    static func parse(data: Data) -> RelayHealth? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        var health = RelayHealth()
        if let assistant = root["assistant"] as? [String: Any] {
            health.branding = AssistantBranding(
                name: assistant["name"] as? String,
                device: assistant["device"] as? String,
                wakePhrase: assistant["wakePhrase"] as? String,
                accentColor: assistant["accentColor"] as? String,
                deviceProfile: assistant["deviceProfile"] as? String,
                deviceLabel: assistant["deviceLabel"] as? String,
                template: assistant["template"] as? String,
                templateSwitching: assistant["templateSwitching"] as? Bool,
                theme: (assistant["theme"] as? [String: Any])?.compactMapValues { $0 as? String },
                logoUrl: assistant["logoUrl"] as? String,
                visualizer: assistant["visualizer"] as? String
            )
        }
        if let voice = root["voice"] as? [String: Any], let active = voice["active"] as? String {
            let providers = (voice["providers"] as? [[String: Any]] ?? []).compactMap { item -> VoiceProviderInfo? in
                guard let id = item["id"] as? String, !id.isEmpty else { return nil }
                return VoiceProviderInfo(
                    id: id,
                    label: (item["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id,
                    kind: item["kind"] as? String ?? "live",
                    configured: item["configured"] as? Bool ?? false,
                    description: (item["description"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                )
            }
            health.voice = VoiceHealth(
                active: active,
                switching: voice["switching"] as? Bool ?? false,
                providers: providers
            )
        }
        return health
    }
}

extension RelayHealthClient: URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        #if DEBUG
        guard allowSelfSigned,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
        #else
        completionHandler(.performDefaultHandling, nil)
        #endif
    }
}
