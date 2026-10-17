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
