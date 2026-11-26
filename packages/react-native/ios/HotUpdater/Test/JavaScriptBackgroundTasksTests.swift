#if canImport(Testing)
import Foundation
import Testing

@testable import HotUpdaterCore

struct JavaScriptBackgroundTasksTests {
    /// JavaScript holds background time while its update requests run, so
    /// iOS doesn't suspend the app before the response reaches it.
    @Test
    func holdsBackgroundTimeUntilJavaScriptEndsIt() {
        let system = SystemTimeRecorder()
        let tasks = JavaScriptBackgroundTasks(execution: system)

        let first = tasks.begin()
        let second = tasks.begin()
        #expect(first != second)
        #expect(system.held == 2)

        tasks.end(first)
        #expect(system.held == 1)
        tasks.end(second)
        #expect(system.held == 0)
    }

    /// JavaScript ends its task in a `finally`, which may run after the
    /// system took the time back, or twice: neither ends another task.
    @Test
    func endingAnExpiredOrEndedTaskDoesNothing() {
        let system = SystemTimeRecorder()
        let tasks = JavaScriptBackgroundTasks(execution: system)

        let expiring = tasks.begin()
        system.expireAll()
        #expect(system.held == 0)
        let running = tasks.begin()

        tasks.end(expiring)
        tasks.end(expiring)
        #expect(system.held == 1)
        tasks.end(running)
        tasks.end(running)
        #expect(system.held == 0)
        #expect(system.ended == 2)
    }

    /// An identifier JavaScript never got, such as the 0 Android returns,
    /// ends nothing.
    @Test
    func endingAnUnknownTaskDoesNothing() {
        let system = SystemTimeRecorder()
        let tasks = JavaScriptBackgroundTasks(execution: system)
        let task = tasks.begin()

        tasks.end(0)
        tasks.end(task + 1)

        #expect(system.held == 1)
    }
}

/// Background time the system hands out and takes back, as UIKit's
/// `beginBackgroundTask` and its expiration handler do.
private final class SystemTimeRecorder: BackgroundExecution {
    private let lock = NSLock()
    private var running: [(expiration: () -> Void, token: BackgroundExecutionToken)] = []
    private var endedCount = 0
    private var begunCount = 0

    var held: Int {
        lock.lock()
        defer { lock.unlock() }
        return begunCount - endedCount
    }

    var ended: Int {
        lock.lock()
        defer { lock.unlock() }
        return endedCount
    }

    func begin(name: String, expiration: @escaping () -> Void) -> BackgroundExecutionToken {
        let token = BackgroundExecutionToken { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.endedCount += 1
            self.lock.unlock()
        }
        lock.lock()
        begunCount += 1
        running.append((expiration, token))
        lock.unlock()
        return token
    }

    /// Runs the expiration handlers and ends the time, as the system does
    /// before it suspends the app.
    func expireAll() {
        lock.lock()
        let current = running
        running = []
        lock.unlock()
        for entry in current {
            entry.expiration()
            entry.token.end()
        }
    }
}
#endif
