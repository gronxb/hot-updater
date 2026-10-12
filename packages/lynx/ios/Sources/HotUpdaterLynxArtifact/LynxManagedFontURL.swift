import Foundation

/// The font dispatcher accepts HTTPS; this reserved origin is always local.
public enum LynxManagedFontURL {
    private static let host = "hot-updater-font.invalid"
    private static let prefix = "https://hot-updater-font.invalid/"

    public static func owns(_ raw: String) -> Bool {
        let normalizedInput = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\t", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
        let authoritySource: Substring
        let start = normalizedInput.prefix(2)
        if start.count == 2, start.allSatisfy({ "/\\".contains($0) }) {
            authoritySource = normalizedInput[...]
        } else if let separator = normalizedInput.firstIndex(of: ":") {
            authoritySource = normalizedInput[normalizedInput.index(after: separator)...]
        } else {
            return false
        }
        let authority = authoritySource
            .drop { "/\\".contains($0) }.prefix { !"/\\?#".contains($0) }
        let hostPort = authority.split(separator: "@", omittingEmptySubsequences: false).last ?? ""
        let candidate = String(hostPort.prefix { $0 != ":" })
        let decoded = candidate.removingPercentEncoding ?? candidate
        let asciiHost = URL(string: "https://\(decoded)/")?.host ?? decoded
        let normalized = asciiHost.hasSuffix(".") ? String(asciiHost.dropLast()) : asciiHost
        return normalized.lowercased() == host
    }

    public static func relativePath(_ raw: String) throws -> String {
        guard let components = URLComponents(string: raw),
              let query = components.percentEncodedQuery,
              query.range(of: #"^hot-updater-generation=[1-9][0-9]*$"#, options: .regularExpression) != nil,
              components.fragment == nil else {
            throw LynxArtifactError.invalid("Invalid managed font URL")
        }
        let relative = String(components.path.dropFirst())
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/")
        guard let encoded = relative.addingPercentEncoding(withAllowedCharacters: allowed),
              raw == "\(prefix)\(encoded)?\(query)", !relative.contains(where: { "%?#".contains($0) }),
              ArchiveExtractionUtilities.normalizedRelativePath(from: relative) == relative else {
            throw LynxArtifactError.invalid("Invalid managed font URL")
        }
        return relative
    }
}
