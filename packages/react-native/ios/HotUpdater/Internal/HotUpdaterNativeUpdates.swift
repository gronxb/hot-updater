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

    func recordRecoveryRequest(_ request: NativeCheckRequest) { impl.recordRecoveryRequest(request) }

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

    func updateBundle(
        _ params: [String: Any],
        onFilesResponse: ((Int, String?) -> Void)?,
        progress: @escaping (Double) -> Void
    ) async throws -> Any? {
        try await promise { resolve, reject in
            // Artifact protocol v2 goes to installArtifact, as the update check
            // in JavaScript sends it.
            if params["filesUrl"] != nil {
                self.impl.installArtifact(
                    params,
                    onProgress: progress,
                    onFilesResponse: onFilesResponse,
                    resolver: resolve,
                    rejecter: reject
                )
            } else {
                self.impl.updateBundle(
                    params,
                    onProgress: progress,
                    onFilesResponse: onFilesResponse,
                    resolver: resolve,
                    rejecter: reject
                )
            }
        }
    }

    func resetChannel() async -> Bool {
        let value = try? await promise { resolve, reject in
            self.impl.resetChannel(resolve, rejecter: reject)
        }
        return (value as? Bool) ?? false
    }

    func resetChannelIfSelectionCurrent(_ guardParams: [String: Any]) async -> Bool {
        let value = try? await promise { resolve, reject in
            self.impl.resetChannelIfSelectionCurrent(guardParams, resolver: resolve, rejecter: reject)
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

/// The impl and native update checker of each instance name, shared by the
/// `HotUpdaterInstance`s of that name and by the TurboModule of each React
/// Native runtime that runs its bundle.
@objc(HotUpdaterNativeUpdateBridge)
public final class HotUpdaterNativeUpdateBridge: NSObject {
    private static let lock = NSLock()
    // Keyed by impl identity: a checker holds its impl, so the impl and its
    // identifier live as long as the process.
    private static var checkers: [ObjectIdentifier: NativeUpdateChecker] = [:]
    private static var namedImpls: [String: HotUpdaterImpl] = [:]
    /// The launch URLs named impls handed out, which tell the TurboModule of
    /// each React Native runtime whose bundle it runs.
    static let router = HotUpdaterInstanceRouter()

    /// Main's impl, which HotUpdater.mm's `sharedImpl` returns too.
    /// Record the bundle and main's options in `HotUpdaterConfig` first:
    /// creating it fixes main's isolation key from them and that bundle's
    /// Info.plist.
    @objc public static let sharedImpl = HotUpdaterImpl()

    /// The impl of `environment`'s name: `sharedImpl` for main, otherwise
    /// one per name, created on first use. A name is one service, so an
    /// instance of an existing name with another bundle, channel,
    /// fingerprint hash, or public key throws, as on Android.
    static func impl(for environment: HotUpdaterInstanceEnvironment) throws -> HotUpdaterImpl {
        guard !environment.isMain else {
            return sharedImpl
        }
        lock.lock()
        defer { lock.unlock() }
        if let impl = namedImpls[environment.name] {
            guard impl.environment.hasSameConfiguration(environment) else {
                throw NativeUpdateCheckError.hotUpdater(
                    "HotUpdater instance \"\(environment.name)\" was already created with another bundle, channel, fingerprintHash, or publicKey"
                )
            }
            return impl
        }
        let impl = HotUpdaterImpl(environment: environment)
        namedImpls[environment.name] = impl
        return impl
    }

    /// The impl of the React Native runtime that runs `bundleURL`: the named
    /// impl that handed it out or keeps it in its storage, otherwise main's.
    /// Each runtime's TurboModule asks with its own bundle URL, since
    /// JavaScript never names its instance.
    @objc(implForBundleURL:)
    public static func impl(forBundleURL bundleURL: URL?) -> HotUpdaterImpl {
        lock.lock()
        let impls = namedImpls
        lock.unlock()
        let name = router.resolve(
            bundleURL: bundleURL,
            candidates: Array(impls.keys),
            documentsPath: FileManagerService().documentsPath()
        )
        return impls[name] ?? sharedImpl
    }

    /// One checker per impl, so its gate serializes every native check of
    /// that instance name.
    static func checker(impl: HotUpdaterImpl) -> NativeUpdateChecker {
        lock.lock()
        defer { lock.unlock() }
        if let checker = checkers[ObjectIdentifier(impl)] {
            return checker
        }
        let checker = NativeUpdateChecker(host: HotUpdaterImplUpdateHost(impl: impl))
        checkers[ObjectIdentifier(impl)] = checker
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

    /// `resetChannelIfSelectionCurrent` for JavaScript: waits for a native
    /// check or staging as `resetChannel` does, then resets only while the
    /// Release selection `params` names is current.
    @objc(resetChannelIfSelectionCurrentWithImpl:params:resolver:rejecter:)
    public static func resetChannelIfSelectionCurrent(
        impl: HotUpdaterImpl,
        params: [AnyHashable: Any]?,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let checker = checker(impl: impl)
        Task {
            await checker.whenIdle {
                await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                    impl.resetChannelIfSelectionCurrent(params, resolver: { value in
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
///
/// `options.name` picks the state the instance works on; see
/// `HotUpdaterOptions.name`.
@objc public final class HotUpdaterInstance: NSObject, @unchecked Sendable {
    @objc public let options: HotUpdaterOptions
    private let impl: HotUpdaterImpl

    /// Throws when `baseURL` is not an absolute HTTP(S) URL, as
    /// `HotUpdater.init` does, when `name` is not 1 to 32 of `a-z`, `0-9`,
    /// and `-`, or when an instance of the same `name`, `main` included, was
    /// created or launched with another bundle, channel, fingerprint hash,
    /// or public key. For main, that includes values from the deprecated
    /// `HotUpdater.configure`, and the values main's impl was created with.
    @objc public init(_ options: HotUpdaterOptions) throws {
        _ = try NativeUpdateChecker.validatedBaseURL(options.baseURL)
        _ = HotUpdaterInstanceEnvironment.registerBuildFingerprintHash
        let environment = try HotUpdaterInstanceEnvironment(options: options)
        self.options = options
        if environment.isMain {
            // Before the impl exists: creating it fixes main's isolation key
            // from these values and this bundle's Info.plist. A named
            // instance reads its own options and bundle and leaves main's
            // alone.
            try HotUpdaterMainBundle.shared.claim(options)
        }
        impl = try HotUpdaterNativeUpdateBridge.impl(for: environment)
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
        // Main's impl records the bundle in HotUpdaterConfig for reloads.
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
    @objc public func getBundleId() -> String? { impl.runningBundleId() }

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
