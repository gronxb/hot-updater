import Foundation

/// Serializes the launch's bundle selection with what reads or changes it: the
/// update check's read, so a check never reads metadata the launch is still
/// selecting from, and a channel reset or built-in commit, which delete the
/// downloaded bundles, so React Native never selects a bundle one of them is
/// about to delete.
final class LaunchPreparationLock {
    private let lock = NSLock()

    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// Resets the channel in `storage`. Once it resets, `clearNextLaunch` runs
    /// under the lock, so React Native's next read picks the default channel's
    /// bundle.
    func resetChannel(
        in storage: BundleStorageService,
        clearNextLaunch: () -> Void
    ) -> Result<Bool, Error> {
        withLock {
            let result = storage.resetChannel()
            if case .success = result {
                clearNextLaunch()
            }
            return result
        }
    }

    /// Resets the channel in `storage` while the selection `guardParams` names
    /// is current, as `resetChannel` does. Once it resets, `clearNextLaunch`
    /// runs under the lock.
    func resetChannelIfSelectionCurrent(
        _ guardParams: ReleaseSelectionGuardParams,
        in storage: BundleStorageService,
        clearNextLaunch: () -> Void
    ) -> Result<Bool, Error> {
        withLock {
            let result = storage.resetChannelIfSelectionCurrent(
                catalogId: guardParams.catalogId,
                scopeKey: guardParams.scopeKey,
                generation: guardParams.generation,
                catalogHash: guardParams.catalogHash,
                channel: guardParams.channel,
                selectionContextHash: guardParams.selectionContextHash
            )
            if case .success(true) = result {
                clearNextLaunch()
            }
            return result
        }
    }

    /// Commits `selection` in `storage`. Committing anything but a bundle, such
    /// as the built-in bundle, deletes every downloaded bundle, so it runs
    /// under the lock as a channel reset does. Once it commits,
    /// `clearNextLaunch` runs under the lock, so React Native's next read picks
    /// the built-in bundle.
    func commitReleaseSelection(
        _ selection: PersistedSelection,
        in storage: BundleStorageService,
        clearNextLaunch: () -> Void
    ) -> Bool {
        guard selection.kind != "BUNDLE" else {
            return storage.commitReleaseSelection(selection)
        }
        return withLock {
            let committed = storage.commitReleaseSelection(selection)
            if committed {
                clearNextLaunch()
            }
            return committed
        }
    }
}

/// The two launch selections of one instance: the one React Native's next read
/// of the bundle URL returns, and the one React Native runs in this process. A
/// channel reset or built-in commit clears only the next one, so what
/// JavaScript reads about the running bundle (its ID, base URL, and manifest)
/// stays that bundle's until React Native reloads. Read by native update
/// checks on other threads while React Native sets it.
final class LaunchSelections: @unchecked Sendable {
    private let lock = NSLock()
    private var nextValue: LaunchSelection?
    private var runningValue: LaunchSelection?

    /// The selection React Native's next read of the bundle URL returns, nil
    /// once a reset or built-in commit asks it to select again.
    var next: LaunchSelection? {
        lock.lock()
        defer { lock.unlock() }
        return nextValue
    }

    /// The selection React Native runs in this process.
    var running: LaunchSelection? {
        lock.lock()
        defer { lock.unlock() }
        return runningValue
    }

    /// React Native launches `selection`, and runs it until it reads again.
    func launch(_ selection: LaunchSelection) {
        lock.lock()
        nextValue = selection
        runningValue = selection
        lock.unlock()
    }

    /// The next read selects again; the running bundle stays until it does.
    func clearNext() {
        lock.lock()
        nextValue = nil
        lock.unlock()
    }

    /// Forgets both, before a reload reads the bundle URL again.
    func clear() {
        lock.lock()
        nextValue = nil
        runningValue = nil
        lock.unlock()
    }

    var runningBundleId: String? {
        running?.launchedBundleId
    }

    /// The running bundle's directory as a file:// URL, nil for the built-in
    /// bundle or before React Native launches one.
    func runningBaseURL(in storage: BundleStorageService) -> String? {
        guard let running else { return nil }
        let baseURL = storage.getBaseURL(forBundleId: running.launchedBundleId)
        return baseURL.isEmpty ? nil : baseURL
    }

    /// The running bundle's manifest, empty for the built-in bundle or before
    /// React Native launches one.
    func runningManifest(in storage: BundleStorageService) -> ManifestAssets {
        guard let running else { return [:] }
        return storage.getManifest(forBundleId: running.launchedBundleId)
    }
}

/// The Release selection a guarded change names, as JavaScript sends it.
struct ReleaseSelectionGuardParams {
    let catalogId: String
    let scopeKey: String
    let generation: Int64
    let catalogHash: String
    let channel: String
    let selectionContextHash: String

    init?(_ params: [AnyHashable: Any]?) {
        guard let data = params as? [String: Any],
              let catalogId = data["catalogId"] as? String,
              let scopeKey = data["scopeKey"] as? String,
              let generation = data["generation"] as? NSNumber,
              let catalogHash = data["catalogHash"] as? String,
              let channel = data["channel"] as? String,
              let selectionContextHash = data["selectionContextHash"] as? String else {
            return nil
        }
        self.catalogId = catalogId
        self.scopeKey = scopeKey
        self.generation = generation.int64Value
        self.catalogHash = catalogHash
        self.channel = channel
        self.selectionContextHash = selectionContextHash
    }
}
