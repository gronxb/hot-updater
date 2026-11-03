#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// What resolving a host's JavaScript came to.
enum HotUpdaterSandboxDevResolved {
    case bundle(URL)
    case failure(String)
}

/// Connections, one at a time, and what a reload says when it can't. Exit ends
/// what's still fetching: its requests can't be cancelled, so a connection checks,
/// right before it starts a session, that no Exit came while it fetched. Each
/// connection holds the sandbox's lock while it fetches, so no switch runs beside it.
@MainActor
final class HotUpdaterSandboxDevConnector {
    private let resolve: (String) async -> HotUpdaterSandboxDevResolved
    private let commit: (String, URL) -> Void
    private let lock: HotUpdaterSandboxLock
    private var connections: Task<Void, Never>?
    private var generation = 0

    /// What the last reload couldn't do. A failed connect says so to its completion.
    private(set) var lastError: String?
    var onChange: (() -> Void)?

    /// `resolve` fetches a host's JavaScript; `commit` starts the session on it.
    init(
        resolve: @escaping (String) async -> HotUpdaterSandboxDevResolved,
        commit: @escaping (String, URL) -> Void,
        lock: HotUpdaterSandboxLock = .shared
    ) {
        self.resolve = resolve
        self.commit = commit
        self.lock = lock
    }

    func connect(_ host: String, completion: @escaping (String?) -> Void) {
        let previous = connections
        let started = generation
        connections = Task { @MainActor in
            await previous?.value
            guard lock.take(.devServer) else {
                completion("A preview is being opened. Wait for it, then connect.")
                return
            }
            defer { lock.release(.devServer) }
            let resolved = await resolve(host)
            guard started == generation else {
                // The session ended while this fetched: it says nothing more.
                completion(nil)
                return
            }
            switch resolved {
            case .failure(let message):
                completion(message)
            case .bundle(let url):
                commit(host, url)
                completion(nil)
            }
        }
    }

    /// Fetches the running host's JavaScript again. The session goes on if it can't.
    func reload(_ host: String) {
        connect(host) { [weak self] failure in
            self?.lastError = failure
            self?.onChange?()
        }
    }

    /// The session ended: nothing still fetching starts one.
    func ended() {
        generation += 1
        lastError = nil
    }
}

/// A host as a person typed it: `host:port`, or with its scheme.
enum HotUpdaterSandboxDevHost {
    private static let defaultPort = 8081

    /// The URL of a host, or nil when it isn't one.
    static func normalize(_ entry: String) -> String? {
        var text = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard !text.isEmpty, text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
        let parts = text.components(separatedBy: "://")
        guard parts.count <= 2 else { return nil }
        let scheme = parts.count == 2 ? parts[0].lowercased() : "http"
        guard scheme == "http" || scheme == "https", let authority = parts.last, !authority.isEmpty,
              !authority.contains("/"), !authority.contains("?") else { return nil }
        let afterBracket = authority.components(separatedBy: "]").last ?? authority
        return afterBracket.contains(":") ? "\(scheme)://\(authority)" : "\(scheme)://\(authority):\(defaultPort)"
    }

    /// The defaults of this device, then what was used here, newest first.
    static func listed(isSimulator: Bool, recent: [String]) -> [String] {
        let defaults = isSimulator ? ["http://localhost:\(defaultPort)"] : []
        var seen = Set<String>()
        return (recent + defaults).filter { seen.insert($0).inserted }
    }

    /// The name the screen shows, without the default scheme.
    static func display(_ url: String) -> String {
        url.hasPrefix("http://") ? String(url.dropFirst("http://".count)) : url
    }

    /// `dev=false` JavaScript at an entry.
    static func bundleURL(host: String, entry: HotUpdaterSandboxDevEntry = HotUpdaterSandboxDevEntry()) -> URL? {
        URL(string: "\(host)/\(entry.path).bundle?platform=ios&dev=false&minify=false\(entry.query)")
    }

    private static let notFromManifest: Set<String> = ["platform", "dev", "hot", "minify", "lazy", "transform.bytecode"]

    /// The entry an Expo manifest's `launchAsset` names, with what it asks of the
    /// transform, as Expo's own client asks. Nil without a `launchAsset`.
    static func entry(ofManifest data: Data) -> HotUpdaterSandboxDevEntry? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let launchAsset = json["launchAsset"] as? [String: Any],
              let text = launchAsset["url"] as? String,
              let url = URL(string: text),
              url.path.hasSuffix(".bundle") else { return nil }
        let path = url.path.dropFirst().dropLast(".bundle".count)
        guard !path.isEmpty else { return nil }
        let query = (url.query ?? "")
            .components(separatedBy: "&")
            .filter { !$0.isEmpty && !notFromManifest.contains($0.components(separatedBy: "=")[0]) }
            .map { "&\($0)" }
            .joined()
        return HotUpdaterSandboxDevEntry(path: String(path), query: query)
    }
}

/// Where a server has the app's JavaScript, and what its URL also asks for.
struct HotUpdaterSandboxDevEntry: Equatable {
    var path = "index"
    var query = ""
}
#endif
