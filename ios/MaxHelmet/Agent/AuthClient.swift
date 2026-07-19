import Foundation

/// Talks to the relay's /auth endpoints so riders sign in with username and
/// password instead of pasting a session token. The auth base URL is derived
/// from the relay WebSocket URL (ws→http, wss→https, path dropped), and the
/// self-signed trust toggle applies here exactly as it does to the socket.
/// The iOS counterpart of android/.../agent/AuthClient.kt.
final class AuthClient: NSObject {

    struct User {
        let id: String
        let username: String
        let displayName: String
        let role: String
    }

    struct Login {
        let token: String
        let user: User
    }

    struct Failure: Error {
        let message: String
    }

    private var allowSelfSigned = false
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    deinit {
        // URLSession retains its delegate until invalidated.
        session.finishTasksAndInvalidate()
    }

    /// ws://host:8787/agent → http://host:8787 ; wss://host/agent → https://host
    static func authBaseURL(fromRelay relayURL: String) -> URL? {
        guard var components = URLComponents(string: relayURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.host != nil else { return nil }
        switch components.scheme?.lowercased() {
        case "ws", "http": components.scheme = "http"
        case "wss", "https": components.scheme = "https"
        default: return nil
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url
    }

    /// POST /auth/login. The completion always runs on the main thread.
    func login(
        relayURL: String,
        username: String,
        password: String,
        allowSelfSignedTls: Bool,
        completion: @escaping (Result<Login, Failure>) -> Void
    ) {
        guard let base = Self.authBaseURL(fromRelay: relayURL) else {
            completion(.failure(Failure(message: "中继地址无效，请检查设置")))
            return
        }
        allowSelfSigned = allowSelfSignedTls

        var request = URLRequest(url: base.appendingPathComponent("auth/login"))
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "username": username,
            "password": password
        ])

        session.dataTask(with: request) { data, _, error in
            let result = Self.parseLogin(data: data, transportError: error)
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// POST /auth/logout — best-effort; the caller drops the token regardless.
    func logout(relayURL: String, token: String, allowSelfSignedTls: Bool) {
        guard !token.isEmpty, let base = Self.authBaseURL(fromRelay: relayURL) else { return }
        allowSelfSigned = allowSelfSignedTls

        var request = URLRequest(url: base.appendingPathComponent("auth/logout"))
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        session.dataTask(with: request) { _, _, _ in }.resume()
    }

    private static func parseLogin(data: Data?, transportError: Error?) -> Result<Login, Failure> {
        let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        if let object,
           object["ok"] as? Bool == true,
           let token = object["token"] as? String, !token.isEmpty,
           let userObject = object["user"] as? [String: Any],
           let id = userObject["id"] as? String, !id.isEmpty,
           let username = userObject["username"] as? String, !username.isEmpty {
            let displayName = (userObject["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? username
            let role = userObject["role"] as? String ?? "tester"
            return .success(Login(token: token, user: User(id: id, username: username, displayName: displayName, role: role)))
        }
        // The relay reports failures as {ok:false, error:"…"} (e.g. wrong
        // password, rate limited) — show its message verbatim.
        if let message = object?["error"] as? String, !message.isEmpty {
            return .failure(Failure(message: message))
        }
        return .failure(Failure(message: transportError == nil ? "登录失败，请重试" : "无法连接服务器，请检查中继地址"))
    }
}

// Self-signed TLS opt-in, mirroring AgentSession's delegate: the Lightsail
// test relay uses a self-signed certificate, gated behind the settings toggle.
extension AuthClient: URLSessionDelegate {
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
