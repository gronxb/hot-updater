#if SWIFT_PACKAGE
import Foundation
import HotUpdaterInterface

// Swift Package Manager only: the Objective-C++ module reaches these classes
// through the protocols in HotUpdaterInterface.h, and these conformances make
// the compiler check that the classes still match them.
extension HotUpdaterImpl: HotUpdaterImplInterface {}

extension HotUpdaterConfig: HotUpdaterConfigInterface {}

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

/// The TurboModule's channel reset, event replay, and impl lookup, for the
/// Objective-C++ module.
final class HotUpdaterNativeUpdatesAdapter: NSObject, HotUpdaterNativeUpdatesInterface {
    static let shared = HotUpdaterNativeUpdatesAdapter()

    func resetChannel(
        withImpl impl: HotUpdaterImplInterface,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        HotUpdaterNativeUpdateBridge.resetChannel(impl: impl as! HotUpdaterImpl, resolver: resolve, rejecter: reject)
    }

    func resetChannelIfSelectionCurrent(
        withImpl impl: HotUpdaterImplInterface,
        params: [AnyHashable: Any]?,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        HotUpdaterNativeUpdateBridge.resetChannelIfSelectionCurrent(
            impl: impl as! HotUpdaterImpl,
            params: params,
            resolver: resolve,
            rejecter: reject
        )
    }

    func takeEvents(withImpl impl: HotUpdaterImplInterface) -> String? {
        HotUpdaterNativeUpdateBridge.takeEvents(impl: impl as! HotUpdaterImpl)
    }

    func impl(forBundleURL bundleURL: URL?) -> HotUpdaterImplInterface {
        HotUpdaterNativeUpdateBridge.impl(forBundleURL: bundleURL)
    }
}

@_cdecl("HotUpdaterNativeUpdates")
public func hotUpdaterNativeUpdates() -> HotUpdaterNativeUpdatesInterface {
    HotUpdaterNativeUpdatesAdapter.shared
}
#endif
