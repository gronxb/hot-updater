#if HOT_UPDATER_SANDBOX_LAYER
import Foundation

/// What a preview link asks this build to run.
struct HotUpdaterSandboxLink: Equatable {
    /// The link as it arrived: links dedupe by it.
    let url: String
    let urlScheme: String
    let channel: String
    let fingerprintHash: String

    private static let schemePrefix = "hu-sandbox-"
    private static let maxFingerprintLength = 256
    private static let maxChannelCodePoints = 255
    private static let pattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(
            pattern: "^(hu-sandbox-[a-z0-9-]+)://hot-updater/preview\\?([^#]*)$",
            options: [.caseInsensitive]
        )
    }()

    /// Whether a URL scheme is the sandbox's, so its links never reach the app.
    static func isSandboxScheme(_ scheme: String?) -> Bool {
        scheme?.lowercased().hasPrefix(schemePrefix) == true
    }

    /// `parsePreviewLink` of `@hot-updater/protocol`, which shares its vectors in
    /// test-utils' `sandbox-preview-links.json`: nil for anything else, or a
    /// channel no release can target.
    init?(url: String) {
        let whole = NSRange(url.startIndex..., in: url)
        guard let match = Self.pattern.firstMatch(in: url, range: whole),
              match.range == whole,
              let schemeRange = Range(match.range(at: 1), in: url),
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
