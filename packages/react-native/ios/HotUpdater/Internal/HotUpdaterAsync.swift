#if SWIFT_PACKAGE
// Swift Package Manager: this file is the `HotUpdater` module apps import. It
// re-exports the Objective-C++ module and the Swift implementation, and adds
// the async API, which needs both.
@_exported import HotUpdaterObjC
@_exported import HotUpdaterSwift
import Foundation

private func startPrepare(
    _ options: HotUpdaterCheckOptions,
    timeout: TimeInterval,
    onProgress: ((Double) -> Void)?,
    completion: @escaping (HotUpdaterPrepareResult) -> Void
) -> HotUpdaterNativeUpdateTask {
    // Before the first shared impl, as HotUpdater.mm does.
    HotUpdaterConfig.shared.bundle = options.bundle
    return HotUpdaterNativeUpdateBridge.prepare(
        options,
        timeout: timeout,
        impl: HotUpdaterNativeUpdateBridge.sharedImpl,
        onProgress: onProgress,
        completion: completion
    )
}

private func startCheckForUpdate(
    _ options: HotUpdaterCheckOptions,
    completion: @escaping (HotUpdaterUpdate?, Error?) -> Void
) -> HotUpdaterNativeUpdateTask {
    HotUpdaterConfig.shared.bundle = options.bundle
    return HotUpdaterNativeUpdateBridge.checkForUpdate(
        options,
        impl: HotUpdaterNativeUpdateBridge.sharedImpl,
        completion: completion
    )
}
#else
import Foundation

private func startPrepare(
    _ options: HotUpdaterCheckOptions,
    timeout: TimeInterval,
    onProgress: ((Double) -> Void)?,
    completion: @escaping (HotUpdaterPrepareResult) -> Void
) -> HotUpdaterNativeUpdateTask {
    HotUpdater.__prepare(options, timeout: timeout, onProgress: onProgress, completion: completion)
}

private func startCheckForUpdate(
    _ options: HotUpdaterCheckOptions,
    completion: @escaping (HotUpdaterUpdate?, Error?) -> Void
) -> HotUpdaterNativeUpdateTask {
    HotUpdater.__checkForUpdate(options, completion: completion)
}
#endif

/// Holds the task a Swift caller's cancellation cancels, which may arrive
/// before the task starts.
private final class NativeUpdateTaskHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var task: HotUpdaterNativeUpdateTask?
    private var cancelled = false

    func set(_ task: HotUpdaterNativeUpdateTask) {
        lock.lock()
        self.task = task
        let cancelled = self.cancelled
        lock.unlock()
        if cancelled { task.cancel() }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        lock.unlock()
        task?.cancel()
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
        let handle = NativeUpdateTaskHandle()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                handle.set(startPrepare(options, timeout: timeout, onProgress: onProgress) { result in
                    continuation.resume(returning: result)
                })
            }
        } onCancel: {
            handle.cancel()
        }
    }

    /// Checks for an update without the JavaScript runtime, as JavaScript's
    /// `checkForUpdate` does; nil when there is no update. Cancelling the
    /// caller cancels the check.
    public static func checkForUpdate(_ options: HotUpdaterCheckOptions) async throws -> HotUpdaterUpdate? {
        let handle = NativeUpdateTaskHandle()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                handle.set(startCheckForUpdate(options) { update, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: update)
                    }
                })
            }
        } onCancel: {
            handle.cancel()
        }
    }
}
