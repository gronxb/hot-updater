import Foundation

// A port of @hot-updater/protocol's release catalog format: the catalog types,
// the wire parser, scope and channel keys, and app version canonicalization.
// Release selection reads these in ReleaseSelection.swift, and the shared
// conformance fixture in @hot-updater/test-utils keeps both in step with the
// protocol.
//
// Strings compare as JavaScript compares them, by UTF-16 code units: Swift's
// `==` and `<` treat canonically equivalent strings as equal, which the
// protocol does not.

// MARK: - Constants

enum ReleaseCatalogLimits {
    static let schemaVersion = 1
    static let fallbackPolicy = "BUILTIN_IF_ACTIVE_INELIGIBLE"
    static let maxCrashedBundles = 10
    static let maxTargetCohortsPerRelease = 100
    static let maxDistinctTargetCohortsPerScope = 512
    static let maxCompiledCatalogBytes = 256 * 1024
    /// The largest release catalog response body a client accepts, in UTF-8 bytes.
    static let maxReleaseCatalogWireBytes = maxCompiledCatalogBytes * 2 + 4 * 1024
    static let numericCohortSize = 1000
    static let maxCohortLength = 64
    static let maxChannelCodePoints = 255
    static let maxCatalogSegmentLength = 255
    static let maxSafeInteger: Int64 = 9_007_199_254_740_991
}

// MARK: - Types

enum ReleasePlatform: String {
    case ios
    case android
}

enum ReleaseStrategy: String {
    case appVersion = "APP_VERSION"
    case fingerprint = "FINGERPRINT"
}

enum SelectionKind: String {
    case bundle = "BUNDLE"
    case builtin = "BUILTIN"
}

struct ReleaseCatalogDescriptor {
    let releaseId: String
    let kind: SelectionKind
    let bundleId: String?
    let rolloutCohortCount: Int
    let targetCohorts: [String]
    let shouldForceUpdate: Bool
    let message: String?
}

struct ReleaseCatalog {
    let schemaVersion: Int
    let catalogId: String
    let scopeKey: String
    let generation: Int64
    let catalogHash: String
    let fallbackPolicy: String
    /// Release descriptors ordered newest first.
    let releases: [ReleaseCatalogDescriptor]
    /// Enabled compatible Releases ordered newest first, where a device keeps
    /// its active Release or rolls back to the newest Release before it.
    let rollbackReleases: [ReleaseCatalogDescriptor]
}

/// The scope a catalog belongs to, and the scope a client asks for.
struct ReleaseCatalogScope {
    let platform: ReleasePlatform
    let channelKey: String
    let strategy: ReleaseStrategy
    /// Set only for the fingerprint strategy.
    let fingerprintHash: String?
}

struct ReleaseCatalogError: Error {
    let message: String
}

// MARK: - JavaScript string semantics

extension String {
    /// Whether both strings hold the same UTF-16 code units, as JavaScript's `===`.
    func jsEquals(_ other: String) -> Bool {
        utf16.elementsEqual(other.utf16)
    }

    /// Orders strings by UTF-16 code units, as JavaScript's `<` and `sort()`.
    func jsLess(_ other: String) -> Bool {
        utf16.lexicographicallyPrecedes(other.utf16)
    }

    /// JavaScript's `String.prototype.trim()`.
    var jsTrimmed: String {
        let scalars = unicodeScalars
        guard let start = scalars.firstIndex(where: { !$0.isJSWhitespace }) else {
            return ""
        }
        let end = scalars.lastIndex(where: { !$0.isJSWhitespace })!
        return String(String.UnicodeScalarView(scalars[start...end]))
    }

    /// JavaScript's locale-independent `String.prototype.toLowerCase()`,
    /// including the final sigma rule.
    var jsLowercased: String {
        let scalars = Array(unicodeScalars)
        var result = String.UnicodeScalarView()
        for (index, scalar) in scalars.enumerated() {
            if scalar.value == 0x03A3 {
                result.append(isFinalSigma(scalars, at: index) ? "\u{03C2}" : "\u{03C3}")
            } else {
                result.append(contentsOf: scalar.properties.lowercaseMapping.unicodeScalars)
            }
        }
        return String(result)
    }
}

extension Optional where Wrapped == String {
    func jsEquals(_ other: String?) -> Bool {
        switch (self, other) {
        case (nil, nil): return true
        case let (left?, right?): return left.jsEquals(right)
        default: return false
        }
    }
}

private extension Unicode.Scalar {
    var isJSWhitespace: Bool {
        switch value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A,
             0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
}

/// Unicode's Final_Sigma condition: a cased letter comes before the sigma and
/// none comes after it, skipping case-ignorable characters on both sides.
private func isFinalSigma(_ scalars: [Unicode.Scalar], at index: Int) -> Bool {
    var before = index - 1
    while before >= 0, scalars[before].properties.isCaseIgnorable {
        before -= 1
    }
    guard before >= 0, scalars[before].properties.isCased else {
        return false
    }
    var after = index + 1
    while after < scalars.count, scalars[after].properties.isCaseIgnorable {
        after += 1
    }
    return after >= scalars.count || !scalars[after].properties.isCased
}

private func isASCIIDigit(_ unit: UInt16) -> Bool {
    unit >= 0x30 && unit <= 0x39
}

private func isLowercaseHex(_ unit: UInt16) -> Bool {
    isASCIIDigit(unit) || (unit >= 0x61 && unit <= 0x66)
}

// MARK: - App version

/// The form of an app version that the device and the server compare:
/// `major.minor.patch` of the first version in `appVersion`, such as `1.4.0`
/// for `v1.4`, or nil when it holds none. Prerelease and build parts are
/// dropped.
func canonicalizeAppVersion(_ appVersion: String) -> String? {
    let units = Array(appVersion.utf16)

    // The digit run starting at `start`, when it is 1-16 ASCII digits long.
    func digitRun(at start: Int) -> String? {
        var end = start
        while end < units.count, isASCIIDigit(units[end]) {
            end += 1
        }
        let length = end - start
        guard length >= 1, length <= 16 else {
            return nil
        }
        return String(decoding: units[start..<end], as: UTF16.self)
    }

    var index = 0
    var major: String?
    while index < units.count {
        guard isASCIIDigit(units[index]) else {
            index += 1
            continue
        }
        var end = index
        while end < units.count, isASCIIDigit(units[end]) {
            end += 1
        }
        if let run = digitRun(at: index) {
            major = run
            index = end
            break
        }
        index = end
    }
    guard let major else {
        return nil
    }

    var parts = [major]
    for _ in 0..<2 {
        guard index < units.count, units[index] == 0x2E,
              let run = digitRun(at: index + 1) else {
            break
        }
        parts.append(run)
        index += 1 + run.utf16.count
    }
    while parts.count < 3 {
        parts.append("0")
    }

    for part in parts {
        if part.utf16.count > 1, part.utf16.first == 0x30 {
            return nil
        }
        guard let value = UInt64(part), value <= UInt64(ReleaseCatalogLimits.maxSafeInteger) else {
            return nil
        }
    }
    return parts.joined(separator: ".")
}

// MARK: - Channel keys

/// The channel name a channel key encodes: trimmed and NFC-normalized.
func normalizeChannelName(_ channel: String) -> String {
    channel.jsTrimmed.precomposedStringWithCanonicalMapping
}

func assertCanonicalChannelName(_ channel: String) throws {
    let normalized = normalizeChannelName(channel)
    if normalized.utf16.isEmpty || !normalized.jsEquals(channel) {
        throw ReleaseCatalogError(message: "Channel name must be non-empty, trimmed, and NFC-normalized")
    }
    if normalized.unicodeScalars.count > ReleaseCatalogLimits.maxChannelCodePoints {
        throw ReleaseCatalogError(message: "Channel name must not exceed 255 characters")
    }
}

/// The unpadded base64url form of the channel's UTF-8 bytes.
func encodeChannelKey(_ channel: String) throws -> String {
    try assertCanonicalChannelName(channel)
    return Data(channel.utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func decodeChannelKey(_ channelKey: String) throws -> String {
    let invalid = ReleaseCatalogError(message: "Invalid channel key")
    let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf16)
    var lookup = [UInt16: Int]()
    for (index, unit) in alphabet.enumerated() {
        lookup[unit] = index
    }

    let units = Array(channelKey.utf16)
    guard units.count % 4 != 1 else {
        throw invalid
    }
    var bytes = [UInt8]()
    var index = 0
    while index < units.count {
        let chunk = units[index..<min(index + 4, units.count)]
        var bits = 0
        for (offset, unit) in chunk.enumerated() {
            guard let sextet = lookup[unit] else {
                throw invalid
            }
            bits |= sextet << (18 - offset * 6)
        }
        bytes.append(UInt8((bits >> 16) & 0xFF))
        if chunk.count >= 3 { bytes.append(UInt8((bits >> 8) & 0xFF)) }
        if chunk.count == 4 { bytes.append(UInt8(bits & 0xFF)) }
        index += 4
    }

    let channel = try decodeStrictUTF8(bytes)
    try assertCanonicalChannelName(channel)
    guard try encodeChannelKey(channel).jsEquals(channelKey) else {
        throw ReleaseCatalogError(message: "Channel key is not canonically encoded")
    }
    return channel
}

private func decodeStrictUTF8(_ bytes: [UInt8]) throws -> String {
    let invalid = ReleaseCatalogError(message: "Invalid UTF-8 channel key")
    var scalars = String.UnicodeScalarView()
    var index = 0
    while index < bytes.count {
        let first = UInt32(bytes[index])
        index += 1
        var codePoint: UInt32
        let continuationCount: Int
        if first <= 0x7F {
            codePoint = first
            continuationCount = 0
        } else if first & 0xE0 == 0xC0 {
            codePoint = first & 0x1F
            continuationCount = 1
        } else if first & 0xF0 == 0xE0 {
            codePoint = first & 0x0F
            continuationCount = 2
        } else if first & 0xF8 == 0xF0 {
            codePoint = first & 0x07
            continuationCount = 3
        } else {
            throw invalid
        }
        for _ in 0..<continuationCount {
            guard index < bytes.count, bytes[index] & 0xC0 == 0x80 else {
                throw invalid
            }
            codePoint = (codePoint << 6) | UInt32(bytes[index] & 0x3F)
            index += 1
        }
        if (continuationCount == 1 && codePoint < 0x80)
            || (continuationCount == 2 && codePoint < 0x800)
            || (continuationCount == 3 && codePoint < 0x10000) {
            throw invalid
        }
        guard let scalar = Unicode.Scalar(codePoint) else {
            throw invalid
        }
        scalars.append(scalar)
    }
    return String(scalars)
}

// MARK: - Scope keys

private func assertCatalogSegment(_ value: String, name: String) throws {
    let units = value.utf16
    let isURLSafe = units.allSatisfy { unit in
        switch unit {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2E, 0x5F, 0x7E, 0x2D:
            return true
        default:
            return false
        }
    }
    if units.isEmpty || units.count > ReleaseCatalogLimits.maxCatalogSegmentLength || !isURLSafe {
        throw ReleaseCatalogError(message: "\(name) must be 1-255 URL-safe ASCII characters")
    }
}

func createReleaseCatalogScopeKey(_ scope: ReleaseCatalogScope) throws -> String {
    _ = try decodeChannelKey(scope.channelKey)

    switch scope.strategy {
    case .appVersion:
        return "v1:app-version:\(scope.platform.rawValue):\(scope.channelKey)"
    case .fingerprint:
        let fingerprintHash = scope.fingerprintHash ?? ""
        try assertCatalogSegment(fingerprintHash, name: "Fingerprint hash")
        return "v1:fingerprint:\(scope.platform.rawValue):\(scope.channelKey):\(fingerprintHash)"
    }
}

func parseReleaseCatalogScopeKey(_ scopeKey: String) throws -> ReleaseCatalogScope {
    let invalid = ReleaseCatalogError(message: "Invalid release catalog scope key")
    let segments = scopeKey.unicodeScalars
        .split(separator: ":", omittingEmptySubsequences: false)
        .map { String(String.UnicodeScalarView($0)) }
    guard segments.count >= 4, segments[0] == "v1",
          let platform = ReleasePlatform(rawValue: segments[2]) else {
        throw invalid
    }

    let scope: ReleaseCatalogScope
    if segments[1] == "app-version", segments.count == 4 {
        scope = ReleaseCatalogScope(platform: platform, channelKey: segments[3], strategy: .appVersion, fingerprintHash: nil)
    } else if segments[1] == "fingerprint", segments.count == 5 {
        scope = ReleaseCatalogScope(platform: platform, channelKey: segments[3], strategy: .fingerprint, fingerprintHash: segments[4])
    } else {
        throw invalid
    }

    guard try createReleaseCatalogScopeKey(scope).jsEquals(scopeKey) else {
        throw ReleaseCatalogError(message: "Release catalog scope key is not canonical")
    }
    return scope
}

/// Whether the catalog's scope key names the expected scope.
func hasExpectedReleaseCatalogScope(scopeKey: String, expected: ReleaseCatalogScope) -> Bool {
    guard let parsed = try? parseReleaseCatalogScopeKey(scopeKey) else {
        return false
    }
    return parsed.channelKey.jsEquals(expected.channelKey)
        && parsed.platform == expected.platform
        && parsed.strategy == expected.strategy
        && (parsed.strategy == .appVersion || parsed.fingerprintHash.jsEquals(expected.fingerprintHash))
}

// MARK: - Wire format

/// The length of `value` in UTF-8 bytes, counted as the protocol counts it.
func getUtf8ByteLength(_ value: String) -> Int {
    let units = Array(value.utf16)
    var bytes = 0
    var index = 0
    while index < units.count {
        let code = units[index]
        if code <= 0x7F {
            bytes += 1
        } else if code <= 0x7FF {
            bytes += 2
        } else if code >= 0xD800, code <= 0xDBFF, index + 1 < units.count,
                  units[index + 1] >= 0xDC00, units[index + 1] <= 0xDFFF {
            bytes += 4
            index += 1
        } else {
            bytes += 3
        }
        index += 1
    }
    return bytes
}

/// Parses a release catalog response body as a client accepts it: within the
/// wire limit, in the schema's shape, for the expected scope, and within the
/// cohort limits. Any other body is nil, and unknown fields are dropped.
func parseReleaseCatalog(_ body: String, expectedScope: ReleaseCatalogScope) -> ReleaseCatalog? {
    guard getUtf8ByteLength(body) <= ReleaseCatalogLimits.maxReleaseCatalogWireBytes,
          // As JSON.parse reads it; JSONSerialization differs on edge cases.
          let catalog = StrictJson.parse(body) as? [String: Any] else {
        return nil
    }

    guard let schemaVersion = jsonSafeInteger(catalog["schemaVersion"]),
          schemaVersion == Int64(ReleaseCatalogLimits.schemaVersion),
          let catalogId = jsonString(catalog["catalogId"]), !catalogId.utf16.isEmpty,
          let scopeKey = jsonString(catalog["scopeKey"]),
          let generation = jsonSafeInteger(catalog["generation"]), generation >= 1,
          let catalogHash = jsonString(catalog["catalogHash"]), isCatalogHash(catalogHash),
          let fallbackPolicy = jsonString(catalog["fallbackPolicy"]),
          fallbackPolicy.jsEquals(ReleaseCatalogLimits.fallbackPolicy),
          let releases = parseReleaseDescriptors(catalog["releases"]),
          let rollbackReleases = parseReleaseDescriptors(catalog["rollbackReleases"]),
          hasExpectedReleaseCatalogScope(scopeKey: scopeKey, expected: expectedScope) else {
        return nil
    }

    var distinctTargetCohorts = Set<[UInt16]>()
    for release in releases + rollbackReleases {
        for cohort in release.targetCohorts {
            distinctTargetCohorts.insert(Array(cohort.utf16))
        }
    }
    guard distinctTargetCohorts.count <= ReleaseCatalogLimits.maxDistinctTargetCohortsPerScope else {
        return nil
    }

    return ReleaseCatalog(
        schemaVersion: ReleaseCatalogLimits.schemaVersion,
        catalogId: catalogId,
        scopeKey: scopeKey,
        generation: generation,
        catalogHash: catalogHash,
        fallbackPolicy: fallbackPolicy,
        releases: releases,
        rollbackReleases: rollbackReleases
    )
}

private func parseReleaseDescriptors(_ value: Any?) -> [ReleaseCatalogDescriptor]? {
    guard let entries = value as? [Any] else {
        return nil
    }
    var descriptors = [ReleaseCatalogDescriptor]()
    for entry in entries {
        guard let descriptor = parseReleaseDescriptor(entry) else {
            return nil
        }
        descriptors.append(descriptor)
    }
    return descriptors
}

private func parseReleaseDescriptor(_ value: Any) -> ReleaseCatalogDescriptor? {
    guard let descriptor = value as? [String: Any],
          let releaseId = jsonString(descriptor["releaseId"]), isUUIDv7(releaseId),
          let kind = jsonString(descriptor["kind"]), kind.jsEquals(SelectionKind.bundle.rawValue),
          let bundleId = jsonString(descriptor["bundleId"]),
          let rolloutCohortCount = jsonSafeInteger(descriptor["rolloutCohortCount"]),
          rolloutCohortCount >= 0,
          rolloutCohortCount <= Int64(ReleaseCatalogLimits.numericCohortSize),
          let cohortEntries = descriptor["targetCohorts"] as? [Any],
          cohortEntries.count <= ReleaseCatalogLimits.maxTargetCohortsPerRelease,
          let shouldForceUpdate = jsonBoolean(descriptor["shouldForceUpdate"]) else {
        return nil
    }
    var targetCohorts = [String]()
    for entry in cohortEntries {
        guard let cohort = jsonString(entry) else {
            return nil
        }
        targetCohorts.append(cohort)
    }
    let message: String?
    switch descriptor["message"] {
    case is NSNull:
        message = nil
    case let value:
        guard let text = jsonString(value) else {
            return nil
        }
        // Shown to the user, so as the JSON spelled it.
        message = StrictJson.originalKey(text)
    }

    return ReleaseCatalogDescriptor(
        releaseId: releaseId,
        kind: .bundle,
        bundleId: bundleId,
        rolloutCohortCount: Int(rolloutCohortCount),
        targetCohorts: targetCohorts,
        shouldForceUpdate: shouldForceUpdate,
        message: message
    )
}

/// Whether `value` is a canonical UUIDv7 in lowercase hex.
func isUUIDv7(_ value: String) -> Bool {
    let units = Array(value.utf16)
    guard units.count == 36 else {
        return false
    }
    for (index, unit) in units.enumerated() {
        switch index {
        case 8, 13, 18, 23:
            guard unit == 0x2D else { return false }
        case 14:
            guard unit == 0x37 else { return false }
        case 19:
            guard unit == 0x38 || unit == 0x39 || unit == 0x61 || unit == 0x62 else { return false }
        default:
            guard isLowercaseHex(unit) else { return false }
        }
    }
    return true
}

private func isCatalogHash(_ value: String) -> Bool {
    let units = Array(value.utf16)
    let prefix = Array("sha256:".utf16)
    return units.count == prefix.count + 64
        && units.starts(with: prefix)
        && units.dropFirst(prefix.count).allSatisfy(isLowercaseHex)
}

// JSONSerialization returns booleans and numbers as NSNumber; the CF type tells
// them apart as JavaScript's typeof does.

private func isJSONBoolean(_ number: NSNumber) -> Bool {
    CFGetTypeID(number) == CFBooleanGetTypeID()
}

private func jsonString(_ value: Any?) -> String? {
    guard let value, !(value is NSNumber) else {
        return nil
    }
    return value as? String
}

private func jsonBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, isJSONBoolean(number) else {
        return nil
    }
    return number.boolValue
}

/// The value as JavaScript's `Number.isSafeInteger` accepts it, so `3.0` and
/// `3e0` count and booleans do not.
private func jsonSafeInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, !isJSONBoolean(number) else {
        return nil
    }
    let double = number.doubleValue
    guard double.isFinite, double.rounded(.towardZero) == double,
          abs(double) <= Double(ReleaseCatalogLimits.maxSafeInteger) else {
        return nil
    }
    return Int64(double)
}
