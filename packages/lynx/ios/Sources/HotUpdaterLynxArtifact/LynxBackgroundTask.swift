import Foundation

struct LynxBackgroundSnapshot {
    let taskId = UUID()
    let selection: LynxPolicyReceipt
    let stored: LynxStoredSelection
    let entry: String
    let source: String
}

/// Only the native executor holds this authority; no foreground context is exposed to JS.
final class LynxBackgroundTask {
    let snapshot: LynxBackgroundSnapshot
    private let host: LynxRuntimeHost

    init(snapshot: LynxBackgroundSnapshot, host: LynxRuntimeHost) {
        self.snapshot = snapshot
        self.host = host
    }

    func reportFatal() throws {
        try host.finishBackground(snapshot.taskId, fatal: true, ended: false)
    }

    /// Call after native execution has ended, not when JS requests completion.
    func executionEnded() throws {
        try host.finishBackground(snapshot.taskId, fatal: false, ended: true)
    }
}
