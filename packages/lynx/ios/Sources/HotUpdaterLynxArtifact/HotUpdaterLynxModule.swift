#if canImport(Lynx)
import Foundation
import Lynx

public final class HotUpdaterLynxModuleContext {
    public let controller: LynxController
    public let launch: LynxLaunchContext
    public init(controller: LynxController, launch: LynxLaunchContext) { self.controller = controller; self.launch = launch }
}

/// Register per LynxConfig using a native-created HotUpdaterLynxModuleContext.
@objc public final class HotUpdaterLynx: NSObject, LynxModule {
    public static var name: String { "HotUpdaterLynx" }
    public static var methodLookup: [String: String] {
        ["getState": NSStringFromSelector(#selector(getState(_:))),
         "acceptCatalog": NSStringFromSelector(#selector(acceptCatalog(_:callback:))),
         "prepareSelection": NSStringFromSelector(#selector(prepareSelection(_:callback:))),
         "stageSelection": NSStringFromSelector(#selector(stageSelection(_:callback:))),
         "setCohort": NSStringFromSelector(#selector(setCohort(_:callback:))),
         "setChannel": NSStringFromSelector(#selector(setChannel(_:callback:))),
         "resetChannel": NSStringFromSelector(#selector(resetChannel(_:))),
         "clearCrashHistory": NSStringFromSelector(#selector(clearCrashHistory(_:))),
         "notifyAppReady": NSStringFromSelector(#selector(notifyAppReady(_:)))]
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
    @objc public func getState(_ callback: LynxCallbackBlock?) {
        do { let value = try bound(); callback?(["ok": true, "data": try value.controller.getState(value.launch)]) }
        catch { failure(error, callback) }
    }
    @objc public func acceptCatalog(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let catalog = params["catalog"] as? [String: Any], let revision = params["expectedRevision"] as? String,
                  let hash = params["selectionContextHash"] as? String else { throw LynxArtifactError.invalid("Invalid catalog parameters") }
            let guardValue = try value.controller.acceptCatalog(JSONSerialization.data(withJSONObject: catalog), expectedRevision: revision, contextHash: hash, context: value.launch)
            callback?(["ok": true, "data": guardValue.dictionary])
        } catch { failure(error, callback) }
    }
    @objc public func prepareSelection(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let guardJSON = params["guard"] as? [String: Any], let selection = params["selection"] as? [String: Any] else { throw LynxArtifactError.invalid("Invalid selection parameters") }
            let guardValue = try LynxCatalogPolicy.parseGuard(guardJSON)
            let receipt = try LynxCatalogPolicy.parseReceipt(selection)
            let artifact: LynxArtifactRequest?
            if params["artifact"] is NSNull { artifact = nil }
            else if let object = params["artifact"] as? [String: Any] { artifact = try JSONDecoder().decode(LynxArtifactRequest.self, from: JSONSerialization.data(withJSONObject: object)) }
            else { throw LynxArtifactError.invalid("Missing artifact parameter") }
            Task {
                do {
                    let id = try await value.controller.prepareSelection(guard: guardValue, receipt: receipt, artifact: artifact, context: value.launch)
                    callback?(["ok": true, "data": ["preparedId": id]])
                } catch { self.failure(error, callback) }
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
    @objc public func setChannel(_ params: [String: Any], callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            guard let channel = params["channel"] as? String else { throw LynxArtifactError.invalid("Missing channel") }
            try value.controller.setChannel(channel, context: value.launch)
            callback?(["ok": true, "data": try value.controller.getState(value.launch)])
        } catch { failure(error, callback) }
    }
    @objc public func resetChannel(_ callback: LynxCallbackBlock?) {
        do {
            let value = try bound()
            callback?(["ok": true, "data": ["reset": try value.controller.resetChannel(value.launch)]])
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
            value.controller.notifyAppReady(value.launch) { result in
                switch result {
                case .success(let status): callback?(["ok": true, "data": ["status": status]])
                case .failure(let error): self.failure(error, callback)
                }
            }
        } catch { failure(error, callback) }
    }
}
#endif
