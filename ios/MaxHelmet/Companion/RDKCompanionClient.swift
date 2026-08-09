import Foundation

protocol CompanionSocketTask: AnyObject {
    func resume()
    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping (Error?) -> Void)
    func receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
}

protocol CompanionHTTPStatusProviding: AnyObject {
    var httpStatusCode: Int? { get }
}

final class RDKCompanionClient {
    typealias SocketFactory = (URLRequest, Bool) -> CompanionSocketTask
    typealias Scheduler = (@escaping () -> Void, TimeInterval) -> Void

    var onState: ((CompanionConnectionState) -> Void)?

    private struct Configuration {
        let relayURL: String
        let sessionToken: String
        let allowSelfSignedTLS: Bool
    }

    private struct InFlightFix {
        let identifier: Int
        let fix: CompanionFix
        let sendEpoch: Int
    }

    private enum ActionFamily {
        case pairing
        case ride
    }

    private static let reconnectDelays: [TimeInterval] = [1, 2, 4, 8, 16, 30]

    private let socketFactory: SocketFactory
    private let schedule: Scheduler
    private var configuration: Configuration?
    private var socket: CompanionSocketTask?
    private var transportState: CompanionConnectionState = .signedOut
    private var generation = 0
    private var reconnectOwner = 0
    private var reconnectSource: CompanionSocketTask?
    private var reconnectAttempts = 0
    private var desiredRide = false
    private var startSentOnSocket = false
    private var canSendLocation = false
    private var pendingFix: CompanionFix?
    private var inFlightFix: InFlightFix?
    private var nextFixSendIdentifier = 0
    private var sendEpoch = 0
    private var pairingActionEpoch = 0
    private var rideActionEpoch = 0

    init(
        socketFactory: @escaping (URLRequest, Bool) -> CompanionSocketTask,
        schedule: @escaping (@escaping () -> Void, TimeInterval) -> Void
    ) {
        self.socketFactory = socketFactory
        self.schedule = schedule
    }

    convenience init() {
        self.init(
            socketFactory: { request, allowSelfSignedTLS in
                DedicatedCompanionSocket(request: request, allowSelfSignedTLS: allowSelfSignedTLS)
            },
            schedule: { block, delay in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block)
            }
        )
    }

    deinit {
        socket?.cancel(with: .goingAway, reason: nil)
    }

    static func companionURL(fromRelay relayURL: String, sessionToken: String) -> URL? {
        let trimmedRelay = relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = sessionToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedRelay.isEmpty,
              !trimmedToken.isEmpty,
              var components = URLComponents(string: trimmedRelay),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              let host = components.host,
              !host.isEmpty else {
            return nil
        }
        components.scheme = scheme
        components.user = nil
        components.password = nil
        components.path = "/companion"
        components.queryItems = [URLQueryItem(name: "token", value: trimmedToken)]
        components.fragment = nil
        return components.url
    }

    func connect(relayURL: String, sessionToken: String, allowSelfSignedTLS: Bool) {
        onMain { [weak self] in
            guard let self else { return }
            self.generation &+= 1
            self.pairingActionEpoch &+= 1
            self.rideActionEpoch &+= 1
            self.invalidateReconnect()
            self.desiredRide = false
            self.clearLocationWork()
            self.socket?.cancel(with: .goingAway, reason: nil)
            self.socket = nil
            self.startSentOnSocket = false
            self.canSendLocation = false
            self.reconnectAttempts = 0

            guard Self.companionURL(fromRelay: relayURL, sessionToken: sessionToken) != nil else {
                self.configuration = nil
                self.publish(.failed(code: "configuration", detail: "Invalid relay URL or session token."))
                return
            }
            self.configuration = Configuration(
                relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
                sessionToken: sessionToken.trimmingCharacters(in: .whitespacesAndNewlines),
                allowSelfSignedTLS: allowSelfSignedTLS
            )
            self.openSocket(generation: self.generation)
        }
    }

    func pair(code: String) {
        onMain { [weak self] in
            guard let self,
                  let message = RDKCompanionProtocol.pairMessage(code: code) else {
                return
            }
            self.pairingActionEpoch &+= 1
            self.sendAction(message, family: .pairing)
        }
    }

    func startRide() {
        onMain { [weak self] in
            guard let self, self.configuration != nil else { return }
            self.desiredRide = true
            if self.socket == nil {
                self.reconnectAttempts = 0
                self.invalidateReconnect()
                self.openSocket(generation: self.generation)
                return
            }
            guard case .ready = self.transportState, !self.startSentOnSocket else { return }
            self.rideActionEpoch &+= 1
            self.startSentOnSocket = true
            self.canSendLocation = true
            self.sendAction(RDKCompanionProtocol.startMessage(), family: .ride)
            self.drainLatestFix()
        }
    }

    func stopRide() {
        onMain { [weak self] in
            guard let self else { return }
            self.rideActionEpoch &+= 1
            self.desiredRide = false
            self.invalidateReconnect()
            self.clearLocationWork()
            self.startSentOnSocket = false
            self.canSendLocation = false
            if self.socket != nil {
                self.sendAction(RDKCompanionProtocol.stopMessage(), family: .ride)
            }
        }
    }

    func unpair() {
        onMain { [weak self] in
            guard let self else { return }
            self.pairingActionEpoch &+= 1
            self.rideActionEpoch &+= 1
            self.desiredRide = false
            self.invalidateReconnect()
            self.clearLocationWork()
            self.startSentOnSocket = false
            self.canSendLocation = false
            if self.socket != nil {
                self.sendAction(RDKCompanionProtocol.unpairMessage(), family: .pairing)
            }
        }
    }

    func sendLatest(_ fix: CompanionFix) {
        onMain { [weak self] in
            guard let self,
                  self.desiredRide,
                  RDKCompanionProtocol.locationMessage(fix) != nil else {
                return
            }
            self.pendingFix = fix
            self.drainLatestFix()
        }
    }

    func disconnect() {
        onMain { [weak self] in
            guard let self else { return }
            self.generation &+= 1
            self.pairingActionEpoch &+= 1
            self.rideActionEpoch &+= 1
            self.invalidateReconnect()
            self.desiredRide = false
            self.configuration = nil
            self.clearLocationWork()
            let oldSocket = self.socket
            self.socket = nil
            self.startSentOnSocket = false
            self.canSendLocation = false
            oldSocket?.cancel(with: .goingAway, reason: nil)
            self.publish(.signedOut)
        }
    }

    private func openSocket(generation expectedGeneration: Int) {
        assert(Thread.isMainThread)
        guard expectedGeneration == generation,
              socket == nil,
              let configuration,
              let url = Self.companionURL(
                fromRelay: configuration.relayURL,
                sessionToken: configuration.sessionToken
              ) else {
            return
        }

        publish(.connecting)
        guard expectedGeneration == generation, socket == nil, self.configuration != nil else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        let newSocket = socketFactory(request, configuration.allowSelfSignedTLS)
        guard expectedGeneration == generation, socket == nil, self.configuration != nil else {
            newSocket.cancel(with: .goingAway, reason: nil)
            return
        }
        socket = newSocket
        transportState = .connecting
        startSentOnSocket = false
        canSendLocation = false
        newSocket.resume()
        guard isCurrent(newSocket, generation: expectedGeneration) else { return }
        receive(on: newSocket, generation: expectedGeneration)
    }

    private func receive(on receivingSocket: CompanionSocketTask, generation expectedGeneration: Int) {
        receivingSocket.receive { [weak self, weak receivingSocket] result in
            guard let self, let receivingSocket else { return }
            self.onMain { [weak self, weak receivingSocket] in
                guard let self,
                      let receivingSocket,
                      self.isCurrent(receivingSocket, generation: expectedGeneration) else {
                    return
                }
                switch result {
                case let .success(message):
                    if let state = RDKCompanionProtocol.parseServerMessage(message) {
                        self.handleServerState(state, on: receivingSocket, generation: expectedGeneration)
                    }
                    if self.isCurrent(receivingSocket, generation: expectedGeneration) {
                        self.receive(on: receivingSocket, generation: expectedGeneration)
                    }
                case .failure:
                    self.handleTransportFailure(on: receivingSocket, generation: expectedGeneration)
                }
            }
        }
    }

    private func handleServerState(
        _ state: CompanionConnectionState,
        on receivingSocket: CompanionSocketTask,
        generation expectedGeneration: Int
    ) {
        assert(Thread.isMainThread)
        let isStatus: Bool
        switch state {
        case .failed:
            isStatus = false
        default:
            isStatus = true
        }
        if isStatus {
            reconnectAttempts = 0
        }

        transportState = state
        switch state {
        case .ready, .sharing:
            canSendLocation = desiredRide
        default:
            canSendLocation = false
        }
        publish(state)

        guard isCurrent(receivingSocket, generation: expectedGeneration) else { return }

        if case .paired = state, !desiredRide {
            socket = nil
            canSendLocation = false
            receivingSocket.cancel(with: .normalClosure, reason: nil)
            return
        }

        if case .ready = state, desiredRide, !startSentOnSocket {
            rideActionEpoch &+= 1
            startSentOnSocket = true
            sendAction(RDKCompanionProtocol.startMessage(), family: .ride)
        }
        guard isCurrent(receivingSocket, generation: expectedGeneration) else { return }
        drainLatestFix()
    }

    private func sendAction(_ text: String, family: ActionFamily) {
        assert(Thread.isMainThread)
        guard let sendingSocket = socket else { return }
        let expectedGeneration = generation
        let expectedActionEpoch = actionEpoch(for: family)
        sendingSocket.send(.string(text)) { [weak self, weak sendingSocket] error in
            guard let self, let sendingSocket, error != nil else { return }
            self.onMain { [weak self, weak sendingSocket] in
                guard let self,
                      let sendingSocket,
                      self.isCurrent(sendingSocket, generation: expectedGeneration),
                      self.actionEpoch(for: family) == expectedActionEpoch else {
                    return
                }
                self.handleTransportFailure(on: sendingSocket, generation: expectedGeneration)
            }
        }
    }

    private func actionEpoch(for family: ActionFamily) -> Int {
        switch family {
        case .pairing: pairingActionEpoch
        case .ride: rideActionEpoch
        }
    }

    private func drainLatestFix() {
        assert(Thread.isMainThread)
        guard desiredRide,
              canSendLocation,
              inFlightFix == nil,
              let sendingSocket = socket,
              let fix = pendingFix,
              let text = RDKCompanionProtocol.locationMessage(fix) else {
            return
        }

        pendingFix = nil
        nextFixSendIdentifier &+= 1
        let operation = InFlightFix(
            identifier: nextFixSendIdentifier,
            fix: fix,
            sendEpoch: sendEpoch
        )
        inFlightFix = operation
        let expectedGeneration = generation

        sendingSocket.send(.string(text)) { [weak self, weak sendingSocket] error in
            guard let self, let sendingSocket else { return }
            self.onMain { [weak self, weak sendingSocket] in
                guard let self,
                      let sendingSocket,
                      self.isCurrent(sendingSocket, generation: expectedGeneration),
                      self.sendEpoch == operation.sendEpoch,
                      self.inFlightFix?.identifier == operation.identifier else {
                    return
                }

                self.inFlightFix = nil
                if error != nil {
                    if self.pendingFix == nil {
                        self.pendingFix = operation.fix
                    }
                    self.handleTransportFailure(on: sendingSocket, generation: expectedGeneration)
                } else {
                    self.drainLatestFix()
                }
            }
        }
    }

    private func handleTransportFailure(
        on failedSocket: CompanionSocketTask,
        generation expectedGeneration: Int
    ) {
        assert(Thread.isMainThread)
        guard isCurrent(failedSocket, generation: expectedGeneration) else { return }
        let httpStatus = (failedSocket as? CompanionHTTPStatusProviding)?.httpStatusCode

        invalidateLocationSends(retainInFlight: true)
        socket = nil
        canSendLocation = false
        startSentOnSocket = false
        failedSocket.cancel(with: .goingAway, reason: nil)

        if httpStatus == 401 {
            desiredRide = false
            invalidateReconnect()
            publish(.failed(code: "auth", detail: "Authentication failed (HTTP 401)."))
            return
        }
        if let httpStatus, httpStatus != 101 {
            desiredRide = false
            invalidateReconnect()
            publish(.failed(code: "connection", detail: "WebSocket upgrade rejected (HTTP \(httpStatus))."))
            return
        }
        guard desiredRide else {
            publish(.failed(code: "connection", detail: "Companion connection closed."))
            return
        }
        scheduleReconnect(generation: expectedGeneration, source: failedSocket)
    }

    private func scheduleReconnect(
        generation expectedGeneration: Int,
        source failedSocket: CompanionSocketTask
    ) {
        assert(Thread.isMainThread)
        guard reconnectAttempts < Self.reconnectDelays.count else {
            reconnectSource = nil
            publish(.failed(code: "connection", detail: "Unable to reconnect after 6 attempts."))
            return
        }
        let delay = Self.reconnectDelays[reconnectAttempts]
        reconnectAttempts += 1
        let expectedOwner = reconnectOwner
        reconnectSource = failedSocket
        schedule({ [weak self, failedSocket] in
            self?.onMain { [weak self] in
                guard let self,
                      self.generation == expectedGeneration,
                      self.reconnectOwner == expectedOwner,
                      self.reconnectSource === failedSocket,
                      self.desiredRide,
                      self.socket == nil else {
                    return
                }
                self.reconnectSource = nil
                self.openSocket(generation: expectedGeneration)
            }
        }, delay)
    }

    private func invalidateReconnect() {
        reconnectOwner &+= 1
        reconnectSource = nil
    }

    private func clearLocationWork() {
        pendingFix = nil
        inFlightFix = nil
        sendEpoch &+= 1
    }

    private func invalidateLocationSends(retainInFlight: Bool) {
        if retainInFlight, pendingFix == nil, let inFlightFix {
            pendingFix = inFlightFix.fix
        }
        inFlightFix = nil
        sendEpoch &+= 1
    }

    private func isCurrent(_ candidate: CompanionSocketTask, generation expectedGeneration: Int) -> Bool {
        expectedGeneration == generation && candidate === socket
    }

    private func publish(_ state: CompanionConnectionState) {
        assert(Thread.isMainThread)
        transportState = state
        onState?(state)
    }

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread {
            block()
        } else {
            DispatchQueue.main.async(execute: block)
        }
    }
}

private final class DedicatedCompanionSocket: NSObject, CompanionSocketTask, CompanionHTTPStatusProviding {
    private let request: URLRequest
    private let allowSelfSignedTLS: Bool
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    private lazy var task = session.webSocketTask(with: request)

    var httpStatusCode: Int? {
        (task.response as? HTTPURLResponse)?.statusCode
    }

    init(request: URLRequest, allowSelfSignedTLS: Bool) {
        self.request = request
        self.allowSelfSignedTLS = allowSelfSignedTLS
        super.init()
    }

    func resume() {
        task.resume()
    }

    func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping (Error?) -> Void) {
        task.send(message, completionHandler: completionHandler)
    }

    func receive(completionHandler: @escaping (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        task.receive(completionHandler: completionHandler)
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        task.cancel(with: closeCode, reason: reason)
        session.invalidateAndCancel()
    }
}

extension DedicatedCompanionSocket: URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        #if DEBUG
        guard allowSelfSignedTLS,
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
