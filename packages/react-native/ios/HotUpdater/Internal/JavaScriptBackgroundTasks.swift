import Foundation

/// The background time JavaScript holds while its update check and download
/// requests run. iOS suspends an app about a second after it leaves the
/// foreground, so a request sent as the user leaves would get its response
/// only when they come back, and native would download with links the server
/// signed long before. JavaScript ends each task by the identifier `begin`
/// returned; the system may take the time back first.
final class JavaScriptBackgroundTasks {
    static let shared = JavaScriptBackgroundTasks(execution: SystemBackgroundExecution())

    private let execution: BackgroundExecution
    private let lock = NSLock()
    private var nextIdentifier = 1
    private var tokens: [Int: BackgroundExecutionToken] = [:]

    init(execution: BackgroundExecution) {
        self.execution = execution
    }

    /// Asks for background time and returns the identifier that ends it.
    func begin() -> Int {
        lock.lock()
        let identifier = nextIdentifier
        nextIdentifier += 1
        lock.unlock()
        // The system ends the time itself once it expires.
        let token = execution.begin(name: "HotUpdater update request") { [weak self] in
            self?.forget(identifier)
        }
        lock.lock()
        tokens[identifier] = token
        lock.unlock()
        return identifier
    }

    /// Ends the time `begin` returned `identifier` for. An identifier that
    /// expired, was ended, or was never handed out ends nothing.
    func end(_ identifier: Int) {
        forget(identifier)?.end()
    }

    @discardableResult
    private func forget(_ identifier: Int) -> BackgroundExecutionToken? {
        lock.lock()
        defer { lock.unlock() }
        return tokens.removeValue(forKey: identifier)
    }
}
