#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// What a preview link asks this build to run.
struct HotUpdaterSandboxLink: Equatable {
    /// The link as it arrived: links dedupe by it.
    let url: String
    let urlScheme: String
    let channel: String
    let fingerprintHash: String
    /// The platform the link is for, `ios` or `android`; nil when it names none.
    let platform: String?

    /// The platform this build's links are for.
    static let ownPlatform = "ios"
    private static let platforms: Set<String> = ["ios", "android"]

    /// The prefix of the scheme a build registered before it could be set.
    private static let schemePrefix = "hu-sandbox-"
    /// The URL type the build registers its scheme in, as the CLI writes it.
    static let urlTypeName = "hot-updater-sandbox"
    /// The Info.plist key the CLI records that scheme in.
    static let urlSchemeKey = "HOT_UPDATER_SANDBOX_URL_SCHEME"
    private static let maxFingerprintLength = 256
    private static let maxChannelCodePoints = 255
    private static let pattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(
            pattern: "^([a-z][a-z0-9+.-]*)://hot-updater/preview\\?([^#]*)$",
            options: [.caseInsensitive]
        )
    }()

    /// This build's own URL scheme, read once from its Info.plist: the launch
    /// path asks for it before anything else runs.
    static let ownScheme: String? = ownScheme(in: Bundle.main.infoDictionary)

    /// What `ownScheme` is when the recorded key breaks the rule: a scheme no
    /// link has, so every link is refused.
    static let noScheme = ""

    /// `recordedSandboxUrlScheme` of `@hot-updater/protocol`, one rule for the
    /// CLI's patch, its artifact reader, and this:
    /// - the key absent: a prerelease's build, which recorded none. The scheme
    ///   of the URL type named `urlTypeName`, in lower case, or nil;
    /// - the key present: a scheme in lower-case ASCII, as written, that the
    ///   one URL type of the name holds alone. Anything else is `noScheme`,
    ///   with no fallback.
    static func ownScheme(in info: [String: Any]?) -> String? {
        let types = info?["CFBundleURLTypes"] as? [[String: Any]] ?? []
        let named = types.filter { $0["CFBundleURLName"] as? String == urlTypeName }
        guard let value = info?[urlSchemeKey] else {
            return (named.first?["CFBundleURLSchemes"] as? [String])?.first?.lowercased()
        }
        guard let recorded = value as? String,
              isRecordedSyntax(recorded),
              named.count == 1,
              named[0]["CFBundleURLSchemes"] as? [String] == [recorded] else {
            return noScheme
        }
        return recorded
    }

    /// `^[a-z][a-z0-9+.-]*$` in ASCII, read before any lower-casing.
    private static func isRecordedSyntax(_ scheme: String) -> Bool {
        let scalars = Array(scheme.unicodeScalars)
        guard let first = scalars.first, ("a"..."z").contains(first) else { return false }
        return scalars.dropFirst().allSatisfy {
            ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "+" || $0 == "." || $0 == "-"
        }
    }

    /// Whether a URL scheme is this build's, so its links never reach the app:
    /// the one it registered, or without one, the prefix every build had then.
    static func isOwnScheme(_ scheme: String?, own: String? = ownScheme) -> Bool {
        guard let scheme, !scheme.isEmpty, isAscii(scheme) else { return false }
        let lowercased = scheme.lowercased()
        guard let own else { return lowercased.hasPrefix(schemePrefix) }
        return lowercased == own
    }

    /// Case-insensitive matching folds `K` (Kelvin) or `ſ` into a letter: a
    /// scheme is ASCII alone.
    private static func isAscii(_ scheme: Substring) -> Bool {
        scheme.unicodeScalars.allSatisfy(\.isASCII)
    }

    private static func isAscii(_ scheme: String) -> Bool {
        isAscii(scheme[...])
    }

    /// `parsePreviewLink` of `@hot-updater/protocol`, which shares its vectors in
    /// test-utils' `sandbox-preview-links.json`: nil for anything else, or a
    /// channel no release can target. It takes any URL scheme; whether the
    /// link is this build's is `isOwnScheme`. A `platform` other than `ios` or
    /// `android` reads as none.
    init?(url: String) {
        let whole = NSRange(url.startIndex..., in: url)
        guard let match = Self.pattern.firstMatch(in: url, range: whole),
              match.range == whole,
              let schemeRange = Range(match.range(at: 1), in: url),
              Self.isAscii(url[schemeRange]),
              let queryRange = Range(match.range(at: 2), in: url) else {
            return nil
        }
        var parameters: [String: String] = [:]
        for parameter in url[queryRange].split(separator: "&", omittingEmptySubsequences: false) {
            guard let separator = parameter.firstIndex(of: "=") else { return nil }
            let name = String(parameter[..<separator])
            guard parameters[name] == nil,
                  let value = String(parameter[parameter.index(after: separator)...]).removingPercentEncodingStrictly() else {
                return nil
            }
            parameters[name] = value
        }
        guard let channel = parameters["channel"],
              let fingerprintHash = parameters["fingerprint"],
              !fingerprintHash.isEmpty,
              fingerprintHash.utf16.count <= Self.maxFingerprintLength,
              Self.isChannelName(channel) else {
            return nil
        }
        self.url = url
        urlScheme = url[schemeRange].lowercased()
        self.channel = channel
        self.fingerprintHash = fingerprintHash
        platform = parameters["platform"].flatMap { Self.platforms.contains($0) ? $0 : nil }
    }

    /// `assertCanonicalChannelName`: non-empty, trimmed, NFC, at most 255 code points.
    static func isChannelName(_ channel: String) -> Bool {
        let scalars = channel.unicodeScalars
        guard !channel.isEmpty, scalars.count <= maxChannelCodePoints else { return false }
        guard channel.trimmingCharacters(in: .whitespacesAndNewlines).utf16.elementsEqual(channel.utf16) else {
            return false
        }
        return channel.precomposedStringWithCanonicalMapping.utf16.elementsEqual(channel.utf16)
    }
}

private extension String {
    /// `decodeURIComponent`: nil for a malformed escape or malformed UTF-8.
    func removingPercentEncodingStrictly() -> String? {
        var bytes: [UInt8] = []
        var iterator = utf8.makeIterator()
        while let byte = iterator.next() {
            guard byte == UInt8(ascii: "%") else {
                bytes.append(byte)
                continue
            }
            guard let high = iterator.next().flatMap({ Character(UnicodeScalar($0)).hexDigitValue }),
                  let low = iterator.next().flatMap({ Character(UnicodeScalar($0)).hexDigitValue }) else {
                return nil
            }
            bytes.append(UInt8(high * 16 + low))
        }
        return String(bytes: bytes, encoding: .utf8)
    }
}
#endif
