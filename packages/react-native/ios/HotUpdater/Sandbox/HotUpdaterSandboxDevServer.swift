#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// A host the Dev server section lists.
struct HotUpdaterSandboxDevServerHost: Equatable {
    let address: String
    /// Whether it answered, or nil when nobody asked.
    let isRunning: Bool?
}

/// What the screen's Dev server section asks of the sandbox's dev-server mode.
/// Hosts are entered on the device, never taken from a link.
@MainActor
protocol HotUpdaterSandboxDevServer: AnyObject {
    /// Whether this process runs JavaScript from a dev server. Read from the
    /// sandbox process, never from `getBundleId()`, which can't say.
    var isRunningDevServer: Bool { get }
    /// The host of the running session, when there is one.
    var runningDevServerHost: String? { get }
    var devServerHosts: [HotUpdaterSandboxDevServerHost] { get }
    /// Called when `devServerHosts` or the running session changed.
    var onDevServerChange: (() -> Void)? { get set }
    /// Calls back on the main actor with nil once connected, or with what's wrong.
    func connect(host: String, completion: @escaping (String?) -> Void)
    func reloadDevServer()
    func exitDevServer()
}

/// The default until dev-server mode is in this build: it lists the address a
/// simulator would use, and says so when asked to connect.
@MainActor
final class HotUpdaterSandboxNoDevServer: HotUpdaterSandboxDevServer {
    var onDevServerChange: (() -> Void)?
    var isRunningDevServer: Bool { false }
    var runningDevServerHost: String? { nil }

    var devServerHosts: [HotUpdaterSandboxDevServerHost] {
        #if targetEnvironment(simulator)
        return [HotUpdaterSandboxDevServerHost(address: "localhost:8081", isRunning: nil)]
        #else
        return []
        #endif
    }

    func connect(host: String, completion: @escaping (String?) -> Void) {
        completion("This build can't run JavaScript from a dev server yet.")
    }

    func reloadDevServer() {}

    func exitDevServer() {}
}
#endif
