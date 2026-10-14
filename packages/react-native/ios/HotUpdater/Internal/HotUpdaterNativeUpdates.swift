import Foundation
import React

/// Runs the native update check over the same `HotUpdaterImpl` the
/// TurboModule uses, so staging, verification, and patches are shared.
final class HotUpdaterImplUpdateHost: NativeUpdateHost {
    private let impl: HotUpdaterImpl

    init(impl: HotUpdaterImpl) {
        self.impl = impl
    }

    var appVersion: String? { HotUpdaterImpl.appVersion }

    var minBundleId: String { HotUpdaterImpl.minBundleId() }

    func bundleId() -> String? { impl.bundleIdForUpdateCheck() }

    func channel() -> String { impl.getChannel() }

    func defaultChannel() -> String { impl.getDefaultChannel() }

    func cohort() -> String { impl.getCohort() }

    func fingerprintHash() -> String? { impl.getFingerprintHash() }

    func crashHistory() -> [String] { impl.getCrashHistory() }

    func activeUpdateState() -> [String: Any] { impl.getActiveUpdateState() }

    func acceptReleaseCatalog(_ params: [String: Any]) -> Bool {
        impl.acceptReleaseCatalog(params)
    }

    func isReleaseSelectionCurrent(_ params: [String: Any]) -> Bool {
        impl.isReleaseSelectionCurrent(params)
    }

    func commitReleaseSelection(_ params: [String: Any]) async throws -> Bool {
        let value = try await promise { resolve, reject in
            self.impl.commitReleaseSelection(params, resolver: resolve, rejecter: reject)
        }
        return (value as? Bool) ?? false
    }

    func updateBundle(_ params: [String: Any], progress: @escaping (Double) -> Void) async throws -> Any? {
        try await promise { resolve, reject in
            self.impl.updateBundle(params, onProgress: progress, resolver: resolve, rejecter: reject)
        }
    }

    func resetChannel() async -> Bool {
        let value = try? await promise { resolve, reject in
            self.impl.resetChannel(resolve, rejecter: reject)
        }
        return (value as? Bool) ?? false
    }

    func releaseCatalogCache(_ partition: String) -> String? {
        impl.releaseCatalogCacheValue(partition)
    }

    func setReleaseCatalogCache(_ partition: String, value: String) -> Bool {
        impl.setReleaseCatalogCacheValue(partition, value: value)
    }

    func removeReleaseCatalogCache(_ partition: String) {
        impl.removeReleaseCatalogCacheValue(partition)
    }

    func storageItem(_ key: String) -> String? { impl.getStorageItem(key) }

    func setStorageItem(_ key: String, value: String?) { impl.setStorageItem(key, value: value) }

    /// Awaits a TurboModule method's resolve or reject.
    private func promise(
        _ call: @escaping (@escaping RCTPromiseResolveBlock, @escaping RCTPromiseRejectBlock) -> Void
    ) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            call(
                { value in continuation.resume(returning: value) },
                { code, message, error in
                    continuation.resume(throwing: NativeUpdateRejection(
                        code: code,
                        message: message,
                        userInfo: (error as NSError?)?.userInfo ?? [:]
                    ))
                }
            )
        }
    }
}

/// The process's impl and native update checker, shared by
/// `HotUpdaterInstance` and the TurboModule.
@objc(HotUpdaterNativeUpdateBridge)
public final class HotUpdaterNativeUpdateBridge: NSObject {
    private static let lock = NSLock()
    private static var sharedChecker: NativeUpdateChecker?

    /// The process's impl, which HotUpdater.mm's `sharedImpl` returns too.
    /// Record the bundle in `HotUpdaterConfig` first: creating it reads that
    /// bundle's Info.plist.
    @objc public static let sharedImpl = HotUpdaterImpl()

    /// One checker per process, so its gate serializes every native check.
    static func checker(impl: HotUpdaterImpl) -> NativeUpdateChecker {
        lock.lock()
        defer { lock.unlock() }
        if let sharedChecker {
            return sharedChecker
        }
        let checker = NativeUpdateChecker(host: HotUpdaterImplUpdateHost(impl: impl))
        sharedChecker = checker
        return checker
    }

    /// JavaScript's `resetChannel`, run once a native check or download
    /// finishes, which would save its channel again after the reset.
    @objc(resetChannelWithImpl:resolver:rejecter:)
    public static func resetChannel(
        impl: HotUpdaterImpl,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let checker = checker(impl: impl)
        Task {
            await checker.whenIdle {
                await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                    impl.resetChannel({ value in
                        // The reset deleted staged bundles; their queued downloads go too.
                        if (value as? Bool) == true {
                            NativeUpdateEvents.remove(name: "onBundleDownloaded", from: HotUpdaterImplUpdateHost(impl: impl))
                        }
                        resolve(value)
                        done.resume()
                    }, rejecter: { code, message, error in
                        reject(code, message, error)
                        done.resume()
                    })
                }
            }
        }
    }

    /// The queued plugin events as a JSON array, cleared as they are taken.
    @objc(takeEventsWithImpl:)
    public static func takeEvents(impl: HotUpdaterImpl) -> String? {
        let host = HotUpdaterImplUpdateHost(impl: impl)
        return NativeUpdateEvents.take(
            from: host,
            build: NativeUpdateEvents.build(
                appVersion: host.appVersion,
                minBundleId: host.minBundleId,
                cohort: host.cohort()
            )
        )
    }
}

/// The native counterpart of the instance JavaScript's `HotUpdater.init`
/// returns, for apps that check for and stage updates before React Native
/// starts: `checkForUpdate`, the returned update's `updateBundle`,
/// `resetChannel`, and the getters, with this instance's server and request
/// defaults. `bundleURL()` is the bundle React Native starts with.
///
/// An update staged before `bundleURL()` is read applies at this launch;
/// one staged after it applies at the next launch.
@objc public final class HotUpdaterInstance: NSObject, @unchecked Sendable {
    @objc public let options: HotUpdaterOptions
    private let impl: HotUpdaterImpl

    /// Throws when `baseURL` is not an absolute HTTP(S) URL, as
    /// `HotUpdater.init` does.
    @objc public init(_ options: HotUpdaterOptions) throws {
        _ = try NativeUpdateChecker.validatedBaseURL(options.baseURL)
        self.options = options
        // Before the impl exists: creating it reads this bundle's Info.plist.
        HotUpdaterConfig.shared.bundle = options.bundle
        impl = HotUpdaterNativeUpdateBridge.sharedImpl
        super.init()
    }

    private var checker: NativeUpdateChecker {
        HotUpdaterNativeUpdateBridge.checker(impl: impl)
    }

    /// The update the app should apply, or nil when there is none. Unlike
    /// JavaScript, which returns null and calls `onError`, a failed check
    /// throws; it is still reported to plugins as `onUpdateError`. Waits for
    /// other native update work; cancel the caller to stop waiting.
    public func checkForUpdate(_ options: HotUpdaterCheckOptions) async throws -> HotUpdaterUpdate? {
        try await checker.checkForUpdate(NativeCheckRequest(self.options, options))
    }

    /// `checkForUpdate` for Objective-C; completes on the main queue.
    /// `cancel` on the returned task cancels the check.
    @discardableResult
    @objc(checkForUpdate:completion:)
    public func checkForUpdate(
        _ options: HotUpdaterCheckOptions,
        completion: @escaping (HotUpdaterUpdate?, Error?) -> Void
    ) -> HotUpdaterNativeUpdateTask {
        let request = NativeCheckRequest(self.options, options)
        let checker = checker
        return HotUpdaterNativeUpdateTask {
            do {
                let update = try await checker.checkForUpdate(request)
                DispatchQueue.main.async { completion(update, nil) }
            } catch {
                DispatchQueue.main.async { completion(nil, error) }
            }
        }
    }

    /// The bundle React Native starts with: the staged update, or the
    /// `main.jsbundle` embedded in `options.bundle`. Reading it fixes this
    /// launch's bundle.
    @objc public func bundleURL() -> URL? {
        HotUpdaterConfig.shared.bundle = options.bundle
        return impl.bundleURL(bundle: options.bundle)
    }

    /// Clears the runtime channel switch and returns to the default channel's
    /// bundle at the next launch, once other native update work finishes.
    public func resetChannel() async -> Bool {
        await checker.resetChannel()
    }

    /// `resetChannel` for Objective-C; completes on the main queue.
    @objc(resetChannelWithCompletion:)
    public func resetChannel(completion: @escaping (Bool) -> Void) {
        let checker = checker
        Task {
            let reset = await checker.resetChannel()
            DispatchQueue.main.async { completion(reset) }
        }
    }

    @objc public func getAppVersion() -> String? { HotUpdaterImpl.appVersion }

    /// The bundle this launch runs, or nil for the built-in bundle or before
    /// `bundleURL()` is read.
    @objc public func getBundleId() -> String? { impl.getBundleId() }

    @objc public func getMinBundleId() -> String { HotUpdaterImpl.minBundleId() }

    @objc public func getChannel() -> String { impl.getChannel() }

    @objc public func getDefaultChannel() -> String { impl.getDefaultChannel() }

    @objc public func getFingerprintHash() -> String? { impl.getFingerprintHash() }
}

/// A native update call started from Objective-C; cancelling it cancels the
/// check and its requests, as cancelling a Swift task does.
@objc(HotUpdaterNativeUpdateTask)
public final class HotUpdaterNativeUpdateTask: NSObject, @unchecked Sendable {
    private let task: Task<Void, Never>

    init(_ operation: @escaping @Sendable () async -> Void) {
        task = Task { await operation() }
    }

    @objc public func cancel() {
        task.cancel()
    }
}
