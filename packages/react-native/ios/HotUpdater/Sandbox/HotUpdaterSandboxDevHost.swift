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

    /// The entry a server takes by default.
    static let defaultEntry = "index"

    /// `dev=false` JavaScript at an entry.
    static func bundleURL(host: String, entry: String = defaultEntry) -> URL? {
        URL(string: "\(host)/\(entry).bundle?platform=ios&dev=false&minify=false")
    }

    /// The entry an Expo manifest's `launchAsset` names, or nil: its server
    /// resolves `index` from a workspace's root.
    static func entry(ofManifest data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let launchAsset = json["launchAsset"] as? [String: Any],
              let url = (launchAsset["url"] as? String).flatMap(URL.init(string:)),
              url.path.hasSuffix(".bundle") else { return nil }
        let entry = url.path.dropFirst().dropLast(".bundle".count)
        return entry.isEmpty ? nil : String(entry)
    }
}
