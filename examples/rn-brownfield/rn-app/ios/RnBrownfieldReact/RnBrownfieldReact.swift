@_exported import ReactBrownfield
@_implementationOnly import HotUpdater
#if DEBUG
@_implementationOnly import React
#endif
import Foundation

/// The bundle of this framework: the JS bundle, its assets, and the Info.plist
/// that `hot-updater fingerprint create` and `hot-updater channel set` write to.
public let ReactNativeBundle = Bundle(for: DummyClass.self)

/// Returns the closure a host assigns to
/// `ReactNativeBrownfield.shared.bundleURLOverride` before `startReactNative()`.
/// The brownfield runtime calls it on every bundle load, so a reload after an
/// update picks up the new bundle.
///
/// Release builds ask Hot Updater for the bundle: the last update it downloaded
/// and verified, or `main.jsbundle` embedded in this framework. Debug builds
/// load from Metro, like the brownfield default.
///
/// Hot Updater reads its fingerprint and channel from the host app's
/// Info.plist. In a brownfield app they live in this framework's Info.plist
/// instead, so this also hands them to the SDK programmatically.
public func makeHotUpdaterBundleURLOverride() -> () -> URL? {
    configureHotUpdater(from: ReactNativeBundle)
    let frameworkBundle = ReactNativeBundle
    return {
        #if DEBUG
        return RCTBundleURLProvider.sharedSettings().jsBundleURL(
            forBundleRoot: ReactNativeBrownfield.shared.entryFile
        )
        #else
        return HotUpdater.bundleURL(bundle: frameworkBundle)
        #endif
    }
}

private func configureHotUpdater(from bundle: Bundle) {
    let info = bundle.infoDictionary
    HotUpdater.configure(
        withFingerprintHash: info?["HOT_UPDATER_FINGERPRINT_HASH"] as? String,
        publicKey: info?["HOT_UPDATER_PUBLIC_KEY"] as? String,
        channel: info?["HOT_UPDATER_CHANNEL"] as? String,
        // nil keeps the SDK's default cache key, which includes the host app's
        // version: a new host version starts from the embedded bundle again.
        isolationKey: nil
    )
}

class DummyClass {}
