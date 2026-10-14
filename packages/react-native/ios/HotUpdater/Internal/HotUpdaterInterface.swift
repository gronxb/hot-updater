#if SWIFT_PACKAGE
import Foundation
import HotUpdaterInterface

// Swift Package Manager only: the Objective-C++ module reaches these classes
// through the protocols in HotUpdaterInterface.h, and these conformances make
// the compiler check that the classes still match them.
extension HotUpdaterImpl: HotUpdaterImplInterface {}

extension HotUpdaterConfig: HotUpdaterConfigInterface {}

extension HotUpdaterNativeUpdateBridge {
    /// The process's impl, shared by HotUpdater.mm's `sharedImpl` and the
    /// `HotUpdater` module's async API. Record the bundle in
    /// `HotUpdaterConfig` first: creating it reads that bundle's Info.plist.
    public static let sharedImpl = HotUpdaterImpl()
}

@_cdecl("HotUpdaterMakeImpl")
public func hotUpdaterMakeImpl() -> HotUpdaterImplInterface {
    HotUpdaterNativeUpdateBridge.sharedImpl
}

@_cdecl("HotUpdaterAppVersion")
public func hotUpdaterAppVersion() -> NSString? {
    HotUpdaterImpl.appVersion as NSString?
}

@_cdecl("HotUpdaterSharedConfig")
public func hotUpdaterSharedConfig() -> HotUpdaterConfigInterface {
    HotUpdaterConfig.shared
}

/// The native update check for the Objective-C++ module, which passes the
/// Swift classes HotUpdater.h names as `id`.
final class HotUpdaterNativeUpdatesAdapter: NSObject, HotUpdaterNativeUpdatesInterface {
    static let shared = HotUpdaterNativeUpdatesAdapter()

    func bundle(ofOptions options: Any) -> Bundle {
        (options as! HotUpdaterCheckOptions).bundle
    }

    func checkForUpdate(
        _ options: Any,
        impl: HotUpdaterImplInterface,
        completion: @escaping (Any?, Error?) -> Void
    ) -> Any {
        HotUpdaterNativeUpdateBridge.checkForUpdate(
            options as! HotUpdaterCheckOptions,
            impl: impl as! HotUpdaterImpl,
            completion: completion
        )
    }

    func prepare(
        _ options: Any,
        timeout: TimeInterval,
        impl: HotUpdaterImplInterface,
        onProgress: ((Double) -> Void)?,
        completion: @escaping (Any) -> Void
    ) -> Any {
        HotUpdaterNativeUpdateBridge.prepare(
            options as! HotUpdaterCheckOptions,
            timeout: timeout,
            impl: impl as! HotUpdaterImpl,
            onProgress: onProgress,
            completion: completion
        )
    }

    func resetChannel(withImpl impl: HotUpdaterImplInterface, completion: @escaping (Bool) -> Void) {
        HotUpdaterNativeUpdateBridge.resetChannel(impl: impl as! HotUpdaterImpl, completion: completion)
    }

    func resetChannel(
        withImpl impl: HotUpdaterImplInterface,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        HotUpdaterNativeUpdateBridge.resetChannel(impl: impl as! HotUpdaterImpl, resolver: resolve, rejecter: reject)
    }

    func takeEvents(withImpl impl: HotUpdaterImplInterface) -> String? {
        HotUpdaterNativeUpdateBridge.takeEvents(impl: impl as! HotUpdaterImpl)
    }
}

@_cdecl("HotUpdaterNativeUpdates")
public func hotUpdaterNativeUpdates() -> HotUpdaterNativeUpdatesInterface {
    HotUpdaterNativeUpdatesAdapter.shared
}
#endif
