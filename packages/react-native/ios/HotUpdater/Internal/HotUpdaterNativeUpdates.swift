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

    func isLaunchPrepared() -> Bool { impl.isLaunchPrepared() }

    func channel() -> String { impl.getChannel() }

    func defaultChannel() -> String { impl.getDefaultChannel() }

    func cohort() -> String { impl.getCohort() }

    func fingerprintHash() -> String? { impl.getFingerprintHash() }

    func crashHistory() -> [String] { impl.getCrashHistory() }

    func activeUpdateState() -> [String: Any] { impl.getActiveUpdateState() }

    func acceptReleaseCatalog(_ params: [String: Any]) -> Bool {
        impl.acceptReleaseCatalog(params as NSDictionary)
    }

    func isReleaseSelectionCurrent(_ params: [String: Any]) -> Bool {
        impl.isReleaseSelectionCurrent(params as NSDictionary)
    }

    func commitReleaseSelection(_ params: [String: Any]) async throws -> Bool {
        let value = try await promise { resolve, reject in
            self.impl.commitReleaseSelection(params as NSDictionary, resolver: resolve, rejecter: reject)
        }
        return (value as? Bool) ?? false
    }

    func updateBundle(_ params: [String: Any], progress: @escaping (Double) -> Void) async throws -> Any? {
        try await promise { resolve, reject in
            self.impl.updateBundle(params as NSDictionary, onProgress: progress, resolver: resolve, rejecter: reject)
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

/// Backs the `HotUpdater` class methods for native update checks; call those
/// instead.
@objc(HotUpdaterNativeUpdateBridge)
public final class HotUpdaterNativeUpdateBridge: NSObject {
    private static let lock = NSLock()
    private static var sharedChecker: NativeUpdateChecker?

    /// One checker per process, so its gate serializes every native check.
    private static func checker(impl: HotUpdaterImpl) -> NativeUpdateChecker {
        lock.lock()
        defer { lock.unlock() }
        if let sharedChecker {
            return sharedChecker
        }
        let checker = NativeUpdateChecker(host: HotUpdaterImplUpdateHost(impl: impl))
        sharedChecker = checker
        return checker
    }

    @objc(checkForUpdate:impl:completion:)
    public static func checkForUpdate(
        _ options: HotUpdaterCheckOptions,
        impl: HotUpdaterImpl,
        completion: @escaping (HotUpdaterUpdate?, Error?) -> Void
    ) {
        let checker = checker(impl: impl)
        Task {
            do {
                let update = try await checker.checkForUpdate(options)
                DispatchQueue.main.async { completion(update, nil) }
            } catch {
                DispatchQueue.main.async { completion(nil, error) }
            }
        }
    }

    @objc(prepare:timeout:impl:onProgress:completion:)
    public static func prepare(
        _ options: HotUpdaterCheckOptions,
        timeout: TimeInterval,
        impl: HotUpdaterImpl,
        onProgress: ((Double) -> Void)?,
        completion: @escaping (HotUpdaterPrepareResult) -> Void
    ) {
        let checker = checker(impl: impl)
        Task {
            let result = await checker.prepare(options, timeout: timeout, onProgress: onProgress)
            DispatchQueue.main.async { completion(result) }
        }
    }

    @objc(resetChannelWithImpl:completion:)
    public static func resetChannel(impl: HotUpdaterImpl, completion: @escaping (Bool) -> Void) {
        let checker = checker(impl: impl)
        Task {
            let reset = await checker.resetChannel()
            DispatchQueue.main.async { completion(reset) }
        }
    }

    /// The queued plugin events as a JSON array, cleared as they are taken.
    @objc(takeEventsWithImpl:)
    public static func takeEvents(impl: HotUpdaterImpl) -> String? {
        NativeUpdateEvents.take(from: HotUpdaterImplUpdateHost(impl: impl))
    }
}

extension HotUpdater {
    /// Checks for an update and stages it before React Native starts, within
    /// one `timeout` that covers waiting for other native update work, the
    /// requests, and a required update's download. A required update staged
    /// in time is `ready`; otherwise it keeps downloading and is `pending`.
    /// Never throws. `onProgress` receives 0...1 on the main queue.
    public static func prepare(
        _ options: HotUpdaterCheckOptions,
        timeout: TimeInterval = 3,
        onProgress: ((Double) -> Void)? = nil
    ) async -> HotUpdaterPrepareResult {
        await withCheckedContinuation { continuation in
            __prepare(options, timeout: timeout, onProgress: onProgress) { result in
                continuation.resume(returning: result)
            }
        }
    }
}
