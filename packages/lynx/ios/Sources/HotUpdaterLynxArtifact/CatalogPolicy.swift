import CoreFoundation
import Foundation

// Ported from packages/core/src/{releaseCatalog,releaseCatalogScope,rollout}.ts.
// Keep selection, rollout, and context hashing in parity with those sources.
// This validates policy, not the provenance of a remotely supplied catalog.
public struct LynxPolicyError: Error, Equatable, LocalizedError {
    public let code: String
    public let message: String
    public var errorDescription: String? { message }
}

public struct LynxPolicyReceipt: Equatable {
    public let kind: String
    public let releaseId: String?
    public let bundleId: String
    public let catalogId: String?
    public let scopeKey: String?
    public let generation: Int64?
    public let catalogHash: String?
    public let channel: String
    public let selectionContextHash: String?

    public init(kind: String, releaseId: String?, bundleId: String, catalogId: String?, scopeKey: String?, generation: Int64?, catalogHash: String?, channel: String, selectionContextHash: String?) {
        self.kind = kind; self.releaseId = releaseId; self.bundleId = bundleId
        self.catalogId = catalogId; self.scopeKey = scopeKey; self.generation = generation
        self.catalogHash = catalogHash; self.channel = channel; self.selectionContextHash = selectionContextHash
    }

    public var dictionary: [String: Any] {
        ["kind": kind, "releaseId": releaseId as Any? ?? NSNull(), "bundleId": bundleId,
         "catalogId": catalogId as Any? ?? NSNull(), "scopeKey": scopeKey as Any? ?? NSNull(),
         "generation": generation as Any? ?? NSNull(), "catalogHash": catalogHash as Any? ?? NSNull(),
         "channel": channel, "selectionContextHash": selectionContextHash as Any? ?? NSNull()]
    }
}

public struct LynxPolicySnapshot {
    public let revision: String
    public let platform: String
    public let appVersion: String
    public let channel: String
    public let embeddedBundleId: String
    public let minimumBundleId: String
    public let cohort: String
    public let runningSelection: LynxPolicyReceipt
    public let nextSelection: LynxPolicyReceipt?
    public let crashedBundleIds: [String]
    public let unconfirmedReleaseIds: [String]
    public var policyBase: LynxPolicyReceipt { nextSelection ?? runningSelection }

    public init(revision: String, platform: String, appVersion: String, channel: String, embeddedBundleId: String, minimumBundleId: String, cohort: String, runningSelection: LynxPolicyReceipt, nextSelection: LynxPolicyReceipt?, crashedBundleIds: [String], unconfirmedReleaseIds: [String]) {
        self.revision = revision; self.platform = platform; self.appVersion = appVersion; self.channel = channel
        self.embeddedBundleId = embeddedBundleId; self.minimumBundleId = minimumBundleId; self.cohort = cohort
        self.runningSelection = runningSelection; self.nextSelection = nextSelection
        self.crashedBundleIds = crashedBundleIds; self.unconfirmedReleaseIds = unconfirmedReleaseIds
    }
}

public struct LynxPolicyDescriptor: Equatable {
    public let releaseId: String
    public let kind: String
    public let bundleId: String?
    public let rolloutCohortCount: Int
    public let targetCohorts: [String]
    public let shouldForceUpdate: Bool
    public let message: String?
}

public struct LynxPolicyCatalog: Equatable {
    public let catalogId: String
    public let scopeKey: String
    public let generation: Int64
    public let catalogHash: String
    public let releases: [LynxPolicyDescriptor]
    public let rollbackReleases: [LynxPolicyDescriptor]?
    /// The wire catalog is a projection of the compiled catalog for this version.
    public let appVersion: String
}

public struct LynxPolicyHighWater {
    public let generation: Int64
    public let catalogHash: String
    public init(generation: Int64, catalogHash: String) { self.generation = generation; self.catalogHash = catalogHash }
}

public struct LynxPolicyGuard: Equatable {
    public let revision: String
    public let catalogId: String
    public let scopeKey: String
    public let generation: Int64
    public let catalogHash: String
    public let channel: String
    public let selectionContextHash: String
    public var dictionary: [String: Any] {
        ["revision": revision, "catalogId": catalogId, "scopeKey": scopeKey, "generation": generation,
         "catalogHash": catalogHash, "channel": channel, "selectionContextHash": selectionContextHash]
    }
}

public struct LynxPolicyAcceptance {
    public let selectionGuard: LynxPolicyGuard
    public let shouldAdvanceHighWater: Bool
}

public struct LynxPolicyDesired {
    public let receipt: LynxPolicyReceipt
    public let status: String
    public let descriptor: LynxPolicyDescriptor?
}

public struct LynxPolicyAuthorization {
    public let desired: LynxPolicyDesired
    public let reason: String
    let rollback: LynxPolicyRollbackAuthorization?
}

/// Persisted only from a native authorization result, never from bridge status.
struct LynxPolicyRollbackAuthorization: Equatable {
    let receipt: LynxPolicyReceipt
    let fromSelection: LynxPolicyReceipt
}

public enum LynxCatalogPolicy {
    public static let maxCatalogBytes = 256 * 1024 * 2 + 4096
    private static let maxSafeInteger: Int64 = 9_007_199_254_740_991
    private static let nilUUID = "00000000-0000-0000-0000-000000000000"

    private static func fail(_ code: String, _ message: String) -> LynxPolicyError { LynxPolicyError(code: code, message: message) }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) == value.startIndex..<value.endIndex
    }
    private static func uuid(_ value: String) -> Bool { matches(value, "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") }
    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value.rounded(.towardZero) == value, value >= 0, value <= Double(maxSafeInteger) else { return nil }
        return Int64(value)
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    private static func nullableString(_ object: [String: Any], _ key: String) throws -> String? {
        guard let value = object[key] else { throw fail("INVALID_CATALOG", "Missing \(key)") }
        if value is NSNull { return nil }
        guard let result = value as? String else { throw fail("INVALID_CATALOG", "Invalid \(key)") }
        return result
    }

    public static func parseReceipt(_ object: [String: Any]) throws -> LynxPolicyReceipt {
        guard let kind = object["kind"] as? String, ["BUNDLE", "EMBEDDED", "BUILTIN"].contains(kind),
              let bundleId = object["bundleId"] as? String, uuid(bundleId) || (kind != "BUNDLE" && bundleId == nilUUID),
              let channel = object["channel"] as? String else { throw fail("INVALID_RECEIPT", "Invalid selection identity") }
        let releaseId = try nullableString(object, "releaseId")
        guard (kind == "BUILTIN" && releaseId == nil) || (kind != "BUILTIN" && releaseId.map(uuid) == true) else {
            throw fail("INVALID_RECEIPT", "Invalid Release identity")
        }
        let generation: Int64?
        if object["generation"] is NSNull { generation = nil }
        else {
            guard let value = integer(object["generation"]), value > 0 else { throw fail("INVALID_RECEIPT", "Invalid generation") }
            generation = value
        }
        return LynxPolicyReceipt(kind: kind, releaseId: releaseId, bundleId: bundleId,
            catalogId: try nullableString(object, "catalogId"), scopeKey: try nullableString(object, "scopeKey"), generation: generation,
            catalogHash: try nullableString(object, "catalogHash"), channel: channel,
            selectionContextHash: try nullableString(object, "selectionContextHash"))
    }

    public static func parseGuard(_ object: [String: Any]) throws -> LynxPolicyGuard {
        guard let revision = object["revision"] as? String, !revision.isEmpty,
              let catalogId = object["catalogId"] as? String, !catalogId.isEmpty,
              let scopeKey = object["scopeKey"] as? String,
              let generation = integer(object["generation"]), generation > 0,
              let catalogHash = object["catalogHash"] as? String, matches(catalogHash, "^sha256:[0-9a-f]{64}$"),
              let channel = object["channel"] as? String,
              let context = object["selectionContextHash"] as? String, matches(context, "^v1:[0-9a-f]{16}$") else {
            throw fail("INVALID_GUARD", "Invalid native selection guard")
        }
        return LynxPolicyGuard(revision: revision, catalogId: catalogId, scopeKey: scopeKey, generation: generation,
                               catalogHash: catalogHash, channel: channel, selectionContextHash: context)
    }

    public static func parseCatalog(json: Data, snapshot: LynxPolicySnapshot) throws -> LynxPolicyCatalog {
        guard json.count <= maxCatalogBytes else { throw fail("INVALID_CATALOG", "Catalog exceeds wire size limit") }
        let decoded: Any
        do { decoded = try JSONSerialization.jsonObject(with: json) }
        catch { throw fail("INVALID_CATALOG", "Invalid catalog JSON") }
        try rejectDuplicateKeys(json)
        guard let object = decoded as? [String: Any], integer(object["schemaVersion"]) == 1,
              let catalogId = object["catalogId"] as? String, !catalogId.isEmpty,
              let scopeKey = object["scopeKey"] as? String, scopeKey == (try expectedScope(snapshot)),
              let generation = integer(object["generation"]), generation > 0,
              let hash = object["catalogHash"] as? String, matches(hash, "^sha256:[0-9a-f]{64}$"),
              object["fallbackPolicy"] as? String == "BUILTIN_IF_ACTIVE_INELIGIBLE",
              let releaseValues = object["releases"] as? [Any] else { throw fail("INVALID_CATALOG", "Invalid catalog fields or scope") }
        let releases = try descriptors(releaseValues)
        var rollback: [LynxPolicyDescriptor]?
        if let value = object["rollbackReleases"] {
            guard let values = value as? [Any] else { throw fail("INVALID_CATALOG", "Invalid rollback releases") }
            rollback = try descriptors(values)
            let byID = Dictionary(uniqueKeysWithValues: rollback!.map { ($0.releaseId, $0) })
            guard releases.allSatisfy({ byID[$0.releaseId] == $0 }) else { throw fail("INVALID_CATALOG", "Conflicting rollback descriptors") }
        }
        guard Set((releases + (rollback ?? [])).flatMap(\.targetCohorts)).count <= 512 else {
            throw fail("INVALID_CATALOG", "Catalog exceeds distinct cohort limit")
        }
        return LynxPolicyCatalog(catalogId: catalogId, scopeKey: scopeKey, generation: generation, catalogHash: hash,
                                 releases: releases, rollbackReleases: rollback, appVersion: snapshot.appVersion)
    }

    private static func descriptors(_ values: [Any]) throws -> [LynxPolicyDescriptor] {
        var result: [LynxPolicyDescriptor] = []
        for value in values {
            guard let item = value as? [String: Any], let releaseId = item["releaseId"] as? String, uuid(releaseId),
                  result.last.map({ $0.releaseId > releaseId }) ?? true,
                  let kind = item["kind"] as? String,
                  let count = integer(item["rolloutCohortCount"]), count <= 1000,
                  let targets = item["targetCohorts"] as? [String], targets.count <= 100,
                  targets.allSatisfy({ validCohort(normalizeCohort($0)) }),
                  Set(targets.map(normalizeCohort)).count == targets.count,
                  let force = boolean(item["shouldForceUpdate"]) else {
                throw fail("INVALID_CATALOG", "Invalid, duplicate, or unordered Release descriptor")
            }
            let bundleId = try nullableString(item, "bundleId")
            guard (kind == "BUNDLE" && bundleId.map(uuid) == true) || (kind == "EMBEDDED" && bundleId == nil) else {
                throw fail("INVALID_CATALOG", "Invalid descriptor kind/Bundle identity")
            }
            result.append(LynxPolicyDescriptor(releaseId: releaseId, kind: kind, bundleId: bundleId,
                rolloutCohortCount: Int(count), targetCohorts: targets, shouldForceUpdate: force, message: try nullableString(item, "message")))
        }
        return result
    }

    private static func expectedScope(_ snapshot: LynxPolicySnapshot) throws -> String {
        let channel = snapshot.channel
        guard ["ios", "android"].contains(snapshot.platform), !channel.isEmpty,
              channel == trimJS(channel),
              channel.utf8.elementsEqual(channel.precomposedStringWithCanonicalMapping.utf8), channel.unicodeScalars.count <= 255,
              uuid(snapshot.embeddedBundleId) || snapshot.embeddedBundleId == nilUUID,
              uuid(snapshot.minimumBundleId) || snapshot.minimumBundleId == nilUUID,
              !snapshot.revision.isEmpty, !snapshot.appVersion.isEmpty else { throw fail("INVALID_STATE", "Invalid native scope configuration") }
        let key = Data(channel.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "v1:app-version:\(snapshot.platform):\(key)"
    }

    public static func contextHash(snapshot: LynxPolicySnapshot) -> String {
        let base = snapshot.policyBase
        let crashed = Array(Set(snapshot.crashedBundleIds)).sorted().prefix(10)
        let excluded = Array(Set(snapshot.unconfirmedReleaseIds)).sorted()
        var fields = ["\"activeBundleId\":" + quote(base.bundleId), "\"activeReleaseId\":" + (base.releaseId.map(quote) ?? "null"),
                      "\"cohort\":" + quote(normalizeCohort(snapshot.cohort)), "\"crashedBundleIds\":" + array(Array(crashed)),
                      "\"minimumReleaseId\":" + quote(snapshot.minimumBundleId), "\"selectorSchemaVersion\":1",
                      "\"strategy\":\"APP_VERSION\"", "\"strategyValue\":" + quote(snapshot.appVersion)]
        if !excluded.isEmpty { fields.append("\"unconfirmedReleaseIds\":" + array(excluded)) }
        var first: UInt32 = 0x811c9dc5
        var second: UInt32 = 0x9e3779b9
        for code in ("{" + fields.joined(separator: ",") + "}").utf16 {
            first = (first ^ UInt32(code)) &* 0x01000193
            second = (second ^ UInt32(code)) &* 0x85ebca6b
        }
        return String(format: "v1:%08x%08x", first, second)
    }

    /// The controller supplies high-water state for this catalog/scope and the
    /// retained accepted projection, under the same lock as its native snapshot.
    public static func accept(catalog: LynxPolicyCatalog, snapshot: LynxPolicySnapshot, expectedRevision: String,
                              claimedContextHash: String, highestSeen: LynxPolicyHighWater?,
                              previouslyAcceptedCatalog: LynxPolicyCatalog? = nil) throws -> LynxPolicyAcceptance {
        guard expectedRevision == snapshot.revision else { throw fail("STALE_STATE", "Native revision changed") }
        guard catalog.scopeKey == (try expectedScope(snapshot)), catalog.appVersion == snapshot.appVersion else { throw fail("INVALID_CATALOG", "Catalog scope or projection changed") }
        guard claimedContextHash == contextHash(snapshot: snapshot) else { throw fail("CONTEXT_MISMATCH", "Selection context differs from native state") }
        if let previous = highestSeen {
            guard catalog.generation >= previous.generation else { throw fail("STALE_GENERATION", "Catalog generation regressed") }
            guard catalog.generation != previous.generation || catalog.catalogHash == previous.catalogHash else {
                throw fail("GENERATION_HASH_MISMATCH", "Catalog hash changed at the same generation")
            }
        }
        if let previous = previouslyAcceptedCatalog, previous.catalogId == catalog.catalogId,
           previous.scopeKey == catalog.scopeKey, previous.appVersion == catalog.appVersion,
           previous.generation == catalog.generation, previous.catalogHash == catalog.catalogHash,
           previous != catalog {
            throw fail("CATALOG_BODY_MISMATCH", "Accepted catalog content changed without a new generation/hash")
        }
        return LynxPolicyAcceptance(selectionGuard: makeGuard(catalog, snapshot),
            shouldAdvanceHighWater: highestSeen.map { catalog.generation > $0.generation } ?? true)
    }

    private static func makeGuard(_ catalog: LynxPolicyCatalog, _ snapshot: LynxPolicySnapshot) -> LynxPolicyGuard {
        LynxPolicyGuard(revision: snapshot.revision, catalogId: catalog.catalogId, scopeKey: catalog.scopeKey,
            generation: catalog.generation, catalogHash: catalog.catalogHash, channel: snapshot.channel, selectionContextHash: contextHash(snapshot: snapshot))
    }

    /// Rechecks a native-stored receipt without adopting a newer, unstaged Release.
    /// The controller supplies the latest accepted projection/high-water under its lock.
    /// This checks continued eligibility, not original staging authority or confirmation.
    static func isEligibleStored(receipt: LynxPolicyReceipt, catalog: LynxPolicyCatalog,
                                 snapshot: LynxPolicySnapshot, highestSeen: LynxPolicyHighWater?,
                                 rollbackAuthorization: LynxPolicyRollbackAuthorization? = nil) throws -> Bool {
        _ = try expectedScope(snapshot)
        guard receipt.channel == snapshot.channel else { return false }
        let nativeBuiltin = receipt.kind == "BUILTIN" && receipt.releaseId == nil && receipt.bundleId == snapshot.embeddedBundleId
            && receipt.catalogId == nil && receipt.scopeKey == nil && receipt.generation == nil
            && receipt.catalogHash == nil && receipt.selectionContextHash == nil
        if nativeBuiltin { return true }
        let acceptance = try accept(catalog: catalog, snapshot: snapshot, expectedRevision: snapshot.revision,
            claimedContextHash: contextHash(snapshot: snapshot), highestSeen: highestSeen)
        guard !acceptance.shouldAdvanceHighWater,
              receipt.catalogId == catalog.catalogId, receipt.scopeKey == catalog.scopeKey,
              let generation = receipt.generation, generation > 0, generation <= catalog.generation,
              let hash = receipt.catalogHash, matches(hash, "^sha256:[0-9a-f]{64}$"),
              generation != catalog.generation || hash == catalog.catalogHash,
              let context = receipt.selectionContextHash, matches(context, "^v1:[0-9a-f]{16}$") else { return false }
        let base = snapshot.policyBase
        if let baseGeneration = base.generation, base.scopeKey != nil {
            guard base.catalogId == catalog.catalogId, base.scopeKey == catalog.scopeKey, base.channel == snapshot.channel,
                  baseGeneration <= catalog.generation,
                  baseGeneration != catalog.generation || base.catalogHash == catalog.catalogHash else { return false }
        }
        if receipt.kind == "BUILTIN" {
            return receipt.releaseId == nil && receipt.bundleId == snapshot.embeddedBundleId
        }
        let excluded = Set(snapshot.unconfirmedReleaseIds)
        guard let releaseId = receipt.releaseId, !excluded.contains(releaseId),
              let release = (catalog.rollbackReleases ?? catalog.releases).first(where: { $0.releaseId == releaseId }),
              release.kind == receipt.kind else { return false }
        let retainedRollback = rollbackAuthorization.map { proof -> Bool in
            let from = proof.fromSelection
            guard receipt.kind == "BUNDLE", proof.receipt == receipt,
                  from.catalogId == receipt.catalogId, from.scopeKey == receipt.scopeKey, from.channel == receipt.channel,
                  let fromGeneration = from.generation, fromGeneration > 0, fromGeneration <= generation else { return false }
            if let fromRelease = from.releaseId { return releaseId < fromRelease }
            return from.bundleId != snapshot.embeddedBundleId && receipt.bundleId < from.bundleId
        } ?? false
        guard eligible(release, snapshot.cohort) || retainedRollback else { return false }
        if receipt.kind == "EMBEDDED" { return release.bundleId == nil && receipt.bundleId == snapshot.embeddedBundleId }
        return receipt.bundleId == release.bundleId && safeBundle(release, snapshot, excluded, Set(snapshot.crashedBundleIds))
    }

    private static func safeBundle(_ release: LynxPolicyDescriptor, _ snapshot: LynxPolicySnapshot,
                                   _ excluded: Set<String>, _ crashed: Set<String>) -> Bool {
        release.kind == "BUNDLE" && release.bundleId != nil && !excluded.contains(release.releaseId)
            && !crashed.contains(release.bundleId!) && release.bundleId! >= snapshot.minimumBundleId
    }

    public static func desired(catalog: LynxPolicyCatalog, snapshot: LynxPolicySnapshot) -> LynxPolicyDesired? {
        let base = snapshot.policyBase
        let excluded = Set(snapshot.unconfirmedReleaseIds)
        let crashed = Set(snapshot.crashedBundleIds)
        let activeId = base.releaseId
        let hasActive = base.bundleId != snapshot.embeddedBundleId
        func safe(_ release: LynxPolicyDescriptor) -> Bool {
            safeBundle(release, snapshot, excluded, crashed)
        }
        func select(_ release: LynxPolicyDescriptor?, kind: String, status: String) -> LynxPolicyDesired {
            let receipt = LynxPolicyReceipt(kind: kind, releaseId: release?.releaseId,
                bundleId: kind == "BUNDLE" ? release!.bundleId! : snapshot.embeddedBundleId,
                catalogId: catalog.catalogId, scopeKey: catalog.scopeKey, generation: catalog.generation,
                catalogHash: catalog.catalogHash, channel: snapshot.channel, selectionContextHash: contextHash(snapshot: snapshot))
            return LynxPolicyDesired(receipt: receipt, status: status, descriptor: release)
        }
        for release in catalog.releases {
            if excluded.contains(release.releaseId) || !eligible(release, snapshot.cohort) { continue }
            if let activeId { if release.releaseId <= activeId { continue } }
            else if hasActive && (release.bundleId == nil || release.bundleId! <= base.bundleId) { continue }
            if safe(release) { return select(release, kind: "BUNDLE", status: "UPDATE") }
            if release.bundleId == nil { return select(release, kind: "EMBEDDED", status: "ROLLBACK") }
        }
        if activeId != nil || hasActive {
            let rollback = catalog.rollbackReleases ?? catalog.releases
            if let current = rollback.first(where: { $0.releaseId == activeId || (activeId == nil && $0.bundleId == base.bundleId) }),
               safe(current), eligible(current, snapshot.cohort) { return select(current, kind: "BUNDLE", status: "UPDATE") }
            if let previous = rollback.first(where: { release in
                safe(release) && (activeId.map { release.releaseId < $0 } ?? (release.bundleId! < base.bundleId))
            }) { return select(previous, kind: "BUNDLE", status: "ROLLBACK") }
            if base.bundleId <= snapshot.minimumBundleId { return nil }
        }
        return select(nil, kind: "BUILTIN", status: "ROLLBACK")
    }

    public static func authorize(catalog: LynxPolicyCatalog, snapshot: LynxPolicySnapshot, selectionGuard: LynxPolicyGuard,
                                 requestedReceipt: LynxPolicyReceipt) throws -> LynxPolicyAuthorization {
        guard selectionGuard == makeGuard(catalog, snapshot), catalog.scopeKey == (try expectedScope(snapshot)),
              catalog.appVersion == snapshot.appVersion else {
            throw fail("STALE_SELECTION", "Prepared selection no longer matches native state/catalog")
        }
        guard let selected = desired(catalog: catalog, snapshot: snapshot) else { throw fail("NO_DESIRED_RELEASE", "No eligible transition") }
        guard selected.receipt == requestedReceipt else { throw fail("INVALID_RECEIPT", "Receipt is not the native-selected release") }
        let active = snapshot.policyBase
        let target = selected.receipt
        let reason: String
        if active.scopeKey == nil || active.generation == nil { reason = "FIRST_AUTHENTICATED_SELECTION" }
        else if target.catalogId != active.catalogId || target.scopeKey != active.scopeKey {
            throw fail("UNSOLICITED_SCOPE", "Scope switches are not supported by this API")
        } else if target.generation == nil || target.generation! < active.generation! {
            throw fail("STALE_GENERATION", "Transition generation regressed")
        } else if target.generation! > active.generation! { reason = "NEWER_POLICY" }
        else if target.selectionContextHash != active.selectionContextHash { reason = "CONTEXT_RESELECTION" }
        else { throw fail("BACKWARD_NOT_AUTHORIZED", "No new policy or context authorizes this transition") }
        let rollback = selected.status == "ROLLBACK" && selected.receipt.kind == "BUNDLE"
            ? LynxPolicyRollbackAuthorization(receipt: selected.receipt, fromSelection: active) : nil
        return LynxPolicyAuthorization(desired: selected, reason: reason, rollback: rollback)
    }

    private static func normalizeCohort(_ value: String) -> String {
        let value = trimJS(value).lowercased()
        if matches(value, "^[0-9]+$"), let number = Int(value), (1...1000).contains(number) { return String(number) }
        return value
    }
    private static func trimJS(_ value: String) -> String {
        // ECMAScript WhiteSpace + LineTerminator, including BOM (unlike Foundation).
        let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000a}\u{000b}\u{000c}\u{000d}\u{0020}\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}")
        return value.trimmingCharacters(in: whitespace)
    }
    private static func validCohort(_ value: String) -> Bool {
        if let numeric = Int(value), matches(value, "^[0-9]+$") { return (1...1000).contains(numeric) }
        return matches(value, "^[a-z0-9-]{1,64}$") && !matches(value, "^[0-9]+$")
    }
    private static func eligible(_ release: LynxPolicyDescriptor, _ cohort: String) -> Bool {
        let cohort = normalizeCohort(cohort)
        if release.targetCohorts.map(normalizeCohort).contains(cohort) { return true }
        let count = release.rolloutCohortCount
        if count == 0 { return false }
        guard let numeric = Int(cohort), matches(cohort, "^[0-9]+$"), (1...1000).contains(numeric) else {
            return validCohort(cohort) && count == 1000
        }
        if count == 1000 { return true }
        func hash(_ value: String) -> Int { var hash: Int32 = 0; for code in value.utf16 { hash = hash &* 31 &+ Int32(code) }; return Int(hash) }
        func mod(_ value: Int, _ modulus: Int) -> Int { (value % modulus + modulus) % modulus }
        func gcd(_ lhs: Int, _ rhs: Int) -> Int { var a = lhs; var b = rhs; while b != 0 { let next = a % b; a = b; b = next }; return a }
        var multiplier = mod(hash(release.releaseId + ":multiplier"), 997)
        if multiplier == 0 { multiplier = 1 }
        while gcd(multiplier, 1000) != 1 { multiplier = mod(multiplier + 1, 1000); if multiplier == 0 { multiplier = 1 } }
        var t = 0; var nextT = 1; var r = 1000; var nextR = multiplier
        while nextR != 0 {
            let quotient = r / nextR; (t, nextT) = (nextT, t - quotient * nextT); (r, nextR) = (nextR, r - quotient * nextR)
        }
        let position = mod(mod(t, 1000) * (numeric - 1 - mod(hash(release.releaseId + ":offset"), 1000)), 1000)
        return position < count
    }

    private static func array(_ values: [String]) -> String { "[" + values.map(quote).joined(separator: ",") + "]" }
    private static func quote(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 8: result += "\\b"
            case 9: result += "\\t"
            case 10: result += "\\n"
            case 12: result += "\\f"
            case 13: result += "\\r"
            case 0..<32: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    // Foundation accepts duplicate object keys. Detect them before policy sees
    // an ambiguous value; JSONSerialization has already validated the grammar.
    private static func rejectDuplicateKeys(_ data: Data) throws {
        let bytes = Array(data)
        var stack: [Set<String>?] = []
        var index = 0
        while index < bytes.count {
            switch bytes[index] {
            case 123: stack.append([])
            case 91: stack.append(nil)
            case 125, 93: _ = stack.popLast()
            case 34:
                let start = index
                index += 1
                while index < bytes.count && bytes[index] != 34 {
                    if bytes[index] == 92 { index += 1 }
                    index += 1
                }
                var next = index + 1
                while next < bytes.count && [9, 10, 13, 32].contains(bytes[next]) { next += 1 }
                if next < bytes.count && bytes[next] == 58 {
                    let keyData = Data(bytes[start...index])
                    let key = try JSONSerialization.jsonObject(with: keyData, options: .fragmentsAllowed) as! String
                    guard !stack.isEmpty, var keys = stack[stack.count - 1], keys.insert(key).inserted else {
                        throw fail("INVALID_CATALOG", "Duplicate JSON object key")
                    }
                    stack[stack.count - 1] = keys
                }
            default: break
            }
            index += 1
        }
    }
}
