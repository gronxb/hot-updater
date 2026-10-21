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
