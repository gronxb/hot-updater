#if canImport(Lynx)
import CoreFoundation
import Foundation
import Lynx

public final class HotUpdaterLynxModuleContext {
    public let controller: LynxController
    public let launch: LynxLaunchContext
    public let reload: (((@escaping (Result<Void, Error>) -> Void)) -> Void)?
    public let didConfirm: ((LynxConfirmationResult) -> Void)?
    private let bridgeReplies = LynxBridgeReplies()
    public init(controller: LynxController, launch: LynxLaunchContext,
                reload: (((@escaping (Result<Void, Error>) -> Void)) -> Void)? = nil,
                didConfirm: ((LynxConfirmationResult) -> Void)? = nil) {
        self.controller = controller
        self.launch = launch
        self.reload = reload
        self.didConfirm = didConfirm
    }

    func beginReply(
        _ cancellation: @escaping (Error) -> Void
    ) -> LynxBridgeReplies.Ticket? {
        bridgeReplies.register(cancellation)
    }

    func finishReply(
        _ ticket: LynxBridgeReplies.Ticket,
        _ completion: () -> Void
    ) {
        bridgeReplies.settle(ticket, completion)
    }

    func claimReply(_ ticket: LynxBridgeReplies.Ticket) -> Bool {
        bridgeReplies.claim(ticket)
    }

    public func invalidate() {
        bridgeReplies.close()
    }
}

/// Register per LynxConfig using a native-created HotUpdaterLynxModuleContext.
@objc public final class HotUpdaterLynx: NSObject, LynxModule {
    public static var name: String { "HotUpdaterLynx" }
    public static var methodLookup: [String: String] {
        ["getState": NSStringFromSelector(#selector(getState(_:))),
         "acceptCatalog": NSStringFromSelector(#selector(acceptCatalog(_:callback:))),
         "validateSelection": NSStringFromSelector(#selector(validateSelection(_:callback:))),
         "prepareSelection": NSStringFromSelector(#selector(prepareSelection(_:callback:))),
         "stageSelection": NSStringFromSelector(#selector(stageSelection(_:callback:))),
         "setCohort": NSStringFromSelector(#selector(setCohort(_:callback:))),
         "resetChannel": NSStringFromSelector(#selector(resetChannel(_:))),
         "clearCrashHistory": NSStringFromSelector(#selector(clearCrashHistory(_:))),
         "notifyAppReady": NSStringFromSelector(#selector(notifyAppReady(_:))),
         "reload": NSStringFromSelector(#selector(reload(_:)))]
    }
    private let context: HotUpdaterLynxModuleContext?
    public required init(param: Any) { context = param as? HotUpdaterLynxModuleContext; super.init() }
    public override required init() { context = nil; super.init() }
    private func bound() throws -> HotUpdaterLynxModuleContext {
        guard let context else { throw LynxArtifactError.invalid("STALE_CONTEXT: Native module context missing") }
        return context
    }
    private func failure(_ error: Error, _ callback: LynxCallbackBlock?) {
        let code: String
        if let policy = error as? LynxPolicyError { code = policy.code }
        else if let signature = error as? SignatureVerificationError { code = signature.errorCodeString }
        else if case LynxArtifactError.incompatible = error { code = "INCOMPATIBLE" }
        else if case LynxArtifactError.stalePreparation = error { code = "STALE_SELECTION" }
        else if case LynxArtifactError.authorizationRequired = error { code = "STALE_SELECTION" }
        else if error.localizedDescription.hasPrefix("STALE_CONTEXT:") { code = "CONTEXT_REJECTED" }
        else { code = "NATIVE_ERROR" }
        callback?(["ok": false, "error": ["code": code, "message": error.localizedDescription]])
    }
    private func selectionParameters(_ params: [String: Any]) throws -> (
        guardValue: LynxPolicyGuard,
        receipt: LynxPolicyReceipt,
        artifact: LynxArtifactRequest?
    ) {
        guard let guardJSON = params["guard"] as? [String: Any],
              let selection = params["selection"] as? [String: Any] else {
            throw LynxArtifactError.invalid("Invalid selection parameters")
        }
        let guardValue = try LynxCatalogPolicy.parseGuard(guardJSON)
        let receipt = try LynxCatalogPolicy.parseReceipt(selection)
        let artifact: LynxArtifactRequest?
        let rawArtifact = params["artifact"]
        if rawArtifact == nil || rawArtifact is NSNull { artifact = nil }
        else if let object = rawArtifact as? [String: Any] {
            artifact = try JSONDecoder().decode(
                LynxArtifactRequest.self,
                from: JSONSerialization.data(withJSONObject: object)
            )
        } else { throw LynxArtifactError.invalid("Missing artifact parameter") }
        return (guardValue, receipt, artifact)
    }
    @objc public func getState(_ callback: LynxCallbackBlock?) {
        do { let value = try bound(); callback?(["ok": true, "data": try value.controller.getState(value.launch)]) }
        catch { failure(error, callback) }
    }
    @objc public func acceptCatalog(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let catalog = params["catalog"] as? [String: Any],
                  let revision = params["expectedRevision"] as? String,
                  let hash = params["selectionContextHash"] as? String,
                  let targetChannel = params["targetChannel"] as? String,
                  let switchNumber = params["explicitScopeSwitch"] as? NSNumber,
                  CFGetTypeID(switchNumber) == CFBooleanGetTypeID() else {
                throw LynxArtifactError.invalid("Invalid catalog parameters")
            }
            let guardValue = try value.controller.acceptCatalog(
                JSONSerialization.data(withJSONObject: catalog),
                expectedRevision: revision,
                contextHash: hash,
                targetChannel: targetChannel,
                explicitScopeSwitch: switchNumber.boolValue,
                context: value.launch
            )
            callback?(["ok": true, "data": guardValue.dictionary])
        } catch { failure(error, callback) }
    }
    @objc public func validateSelection(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            let parsed = try selectionParameters(params)
            guard let reply = value.beginReply({ self.failure($0, callback) }) else {
                return
            }
            Task {
                do {
                    try await value.controller.validateSelection(
                        guard: parsed.guardValue,
                        receipt: parsed.receipt,
                        artifact: parsed.artifact,
                        context: value.launch
                    )
                    value.finishReply(reply) {
                        callback?(["ok": true, "data": ["validated": true]])
                    }
                } catch {
                    value.finishReply(reply) {
                        self.failure(error, callback)
                    }
                }
            }
        } catch { failure(error, callback) }
    }
    @objc public func prepareSelection(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            let parsed = try selectionParameters(params)
            guard let reply = value.beginReply({ self.failure($0, callback) }) else {
                return
            }
            Task {
                do {
                    let id = try await value.controller.prepareSelection(
                        guard: parsed.guardValue,
                        receipt: parsed.receipt,
                        artifact: parsed.artifact,
                        context: value.launch
                    )
                    value.finishReply(reply) {
                        callback?(["ok": true, "data": ["preparedId": id]])
                    }
                } catch {
                    value.finishReply(reply) {
                        self.failure(error, callback)
                    }
                }
            }
        } catch { failure(error, callback) }
    }
    @objc public func stageSelection(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let id = params["preparedId"] as? String else { throw LynxArtifactError.invalid("Missing prepared token") }
            callback?(["ok": true, "data": try value.controller.stageSelection(id, context: value.launch)])
        } catch { failure(error, callback) }
    }
    @objc public func setCohort(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let cohort = params["cohort"] as? String else { throw LynxArtifactError.invalid("Missing cohort") }
            try value.controller.setCohort(cohort, context: value.launch)
            callback?(["ok": true, "data": try value.controller.getState(value.launch)])
        } catch { failure(error, callback) }
    }
    @objc public func resetChannel(_ callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard value.launch.primary, let reload = value.reload else {
                throw LynxArtifactError.invalid("The native host does not support managed Lynx generation reload")
            }
            guard let reply = value.beginReply({ self.failure($0, callback) }) else {
                return
            }
            do {
                let reset = try value.controller.resetChannel(value.launch)
                DispatchQueue.main.async {
                    guard value.claimReply(reply) else { return }
                    let once = LynxOnceReply<Void> { result in
                        switch result {
                        case .success:
                            callback?(["ok": true, "data": ["reset": reset]])
                        case .failure(let error):
                            self.failure(error, callback)
                        }
                    }
                    reload(once.settle)
                }
            } catch {
                value.finishReply(reply) { self.failure(error, callback) }
            }
        } catch { failure(error, callback) }
    }
    @objc public func clearCrashHistory(_ callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            try value.controller.clearCrashHistory(value.launch)
            callback?(["ok": true, "data": try value.controller.getState(value.launch)])
        } catch { failure(error, callback) }
    }
    @objc public func notifyAppReady(_ callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let reply = value.beginReply({ self.failure($0, callback) }) else {
                return
            }
            value.controller.notifyAppReady(value.launch) { result in
                value.finishReply(reply) {
                    switch result {
                    case .success(let confirmation):
                        value.didConfirm?(confirmation)
                        callback?(["ok": true, "data": confirmation.dictionary])
                    case .failure(let error): self.failure(error, callback)
                    }
                }
            }
        } catch { failure(error, callback) }
    }
    @objc public func reload(_ callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard value.launch.primary, let reload = value.reload else {
                throw LynxArtifactError.invalid("The native host does not support managed Lynx generation reload")
            }
            guard let reply = value.beginReply({ self.failure($0, callback) }) else {
                return
            }
            DispatchQueue.main.async {
                guard value.claimReply(reply) else { return }
                let once = LynxOnceReply<Void> { result in
                    switch result {
                    case .success:
                        callback?(["ok": true, "data": NSNull()])
                    case .failure(let error):
                        self.failure(error, callback)
                    }
                }
                reload(once.settle)
            }
        } catch { failure(error, callback) }
    }
}
#endif
