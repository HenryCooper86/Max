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

    static func parse(data: Data) -> RelayHealth? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        var health = RelayHealth()
        if let assistant = root["assistant"] as? [String: Any] {
            health.branding = AssistantBranding(
                name: assistant["name"] as? String,
                device: assistant["device"] as? String,
                wakePhrase: assistant["wakePhrase"] as? String,
                accentColor: assistant["accentColor"] as? String
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
