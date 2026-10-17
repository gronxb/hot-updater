#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct LaunchPreparationLockTests {
    /// A launch's selection that overlaps a built-in commit or a channel reset
    /// waits for it, so it never picks a bundle the change deletes.
    @Test(arguments: ["commit", "reset"])
    func aLaunchSelectionWaitsForAChangeThatDeletesBundles(change: String) {
        let launchPreparation = LaunchPreparationLock()
        let storage = GatedBundleStorage(holdChange: true)
        let cleared = Counter()
        let changed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            if change == "commit" {
                _ = launchPreparation.commitReleaseSelection(selection("USE_BUILTIN"), in: storage) {
                    cleared.increment()
                }
            } else {
                _ = launchPreparation.resetChannel(in: storage) { cleared.increment() }
            }
            changed.signal()
        }
        #expect(storage.changeEntered.wait(timeout: .now() + 5) == .success)

        let launchBundleId = LockedBox<String?>("unset")
        let selected = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            launchBundleId.value = launchPreparation.withLock { storage.peekLaunchBundleId() }
            selected.signal()
        }

        // The launch's selection runs under the lock the change holds.
        #expect(selected.wait(timeout: .now() + 0.3) == .timedOut)

        storage.releaseChange.signal()
        #expect(changed.wait(timeout: .now() + 5) == .success)
        #expect(selected.wait(timeout: .now() + 5) == .success)
        // Selected after the change, so it sees the built-in bundle, not the deleted download.
        #expect(launchBundleId.value == nil)
        #expect(cleared.value == 1)
    }

    @Test
    func aCommitClearsTheNextLaunchOnlyWhenTheBuiltInBundleCommits() {
        let launchPreparation = LaunchPreparationLock()
        let storage = GatedBundleStorage(holdChange: false)
        let cleared = Counter()

        #expect(launchPreparation.commitReleaseSelection(selection("BUNDLE"), in: storage) { cleared.increment() })
        #expect(cleared.value == 0)
        #expect(storage.peekLaunchBundleId() == "downloaded-bundle")

        storage.commits = false
        #expect(!launchPreparation.commitReleaseSelection(selection("USE_BUILTIN"), in: storage) { cleared.increment() })
        #expect(cleared.value == 0)

        storage.commits = true
        #expect(launchPreparation.commitReleaseSelection(selection("USE_BUILTIN"), in: storage) { cleared.increment() })
        #expect(cleared.value == 1)
        #expect(storage.peekLaunchBundleId() == nil)
    }
}

private func selection(_ kind: String) -> PersistedSelection {
    PersistedSelection(
        kind: kind,
        releaseId: "release",
        bundleId: kind == "BUNDLE" ? "downloaded-bundle" : "built-in",
        catalogId: "catalog",
        scopeKey: "scope",
        generation: 1,
        catalogHash: "hash",
        channel: "production",
        selectionContextHash: "context"
    )
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }
}

private final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) {
        stored = value
    }

    var value: Value {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}

/// Storage whose launch picks a downloaded bundle until a built-in commit or
/// channel reset deletes it, and whose change can be held open to race a
/// launch against it.
private final class GatedBundleStorage: BundleStorageService, @unchecked Sendable {
    let changeEntered = DispatchSemaphore(value: 0)
    let releaseChange = DispatchSemaphore(value: 0)
    private let holdChange: Bool
    private let downloadedBundleId = LockedBox<String?>("downloaded-bundle")
    private let commitsValue = LockedBox(true)

    var commits: Bool {
        get { commitsValue.value }
        set { commitsValue.value = newValue }
    }

    init(holdChange: Bool) {
        self.holdChange = holdChange
    }

    private func deleteDownloadedBundles() {
        changeEntered.signal()
        if holdChange {
            _ = releaseChange.wait(timeout: .now() + 5)
        }
        downloadedBundleId.value = nil
    }

    func peekLaunchBundleId() -> String? { downloadedBundleId.value }

    func commitReleaseSelection(_ selection: PersistedSelection) -> Bool {
        guard commits else { return false }
        if selection.kind != "BUNDLE" {
            deleteDownloadedBundles()
        }
        return true
    }

    func resetChannel() -> Result<Bool, Error> {
        deleteDownloadedBundles()
        return .success(true)
    }

    func setBundleURL(localPath _: String?) -> Result<Void, Error> { .success(()) }
    func getCachedBundleURL() -> URL? { nil }
    func getFallbackBundleURL(bundle _: Bundle) -> URL? { nil }
    func prepareLaunch(bundle _: Bundle, pendingRecovery _: PendingCrashRecovery?) -> LaunchSelection {
        LaunchSelection(bundleURL: nil, launchedBundleId: peekLaunchBundleId(), shouldRollbackOnCrash: false)
    }
    func updateBundle(
        bundleId _: String,
        manifestUrl _: URL,
        manifestFileHash _: String,
        archiveUrl _: URL?,
        assets _: [String: ChangedAssetDescriptor],
        fileResolver _: ArtifactFileResolver?,
        selection _: PersistedSelection?,
        progressHandler _: @escaping (UpdateProgressPayload) -> Void,
        completion _: @escaping (Result<UpdateDelivery, Error>) -> Void
    ) {}
    func markLaunchStarted(bundleId _: String?) {}
    func markLaunchCompleted(bundleId _: String?) {}
    func notifyAppReady() -> [String: Any] { [:] }
    func getCrashHistory() -> CrashedHistory { CrashedHistory() }
    func clearCrashHistory() -> Bool { true }
    func getInstallId() -> String { "install" }
    func getBaseURL() -> String { "" }
    func getBaseURL(forBundleId _: String?) -> String { "" }
    func getBundleId() -> String? { nil }
    func getManifest() -> ManifestAssets { [:] }
    func getManifest(forBundleId _: String?) -> ManifestAssets { [:] }
}
#endif
