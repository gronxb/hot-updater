import Foundation

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
    /// transform: without Hermes's profile, its JavaScript has syntax Hermes
    /// refuses. Nil without a `launchAsset`.
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
