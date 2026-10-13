import Foundation

// A port of @hot-updater/protocol's release selection: cohort rollout, the
// selection context hash, the desired Release, and transition authorization.
// The shared conformance fixture in @hot-updater/test-utils keeps it in step
// with the protocol.

// MARK: - Cohorts

private func parseNumericCohortValue(_ cohort: String) -> Int? {
    let units = cohort.utf16
    guard !units.isEmpty, units.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else {
        return nil
    }
    // Leading zeros are dropped first, so a long run of them stays in range.
    let significant = units.drop(while: { $0 == 0x30 })
    guard !significant.isEmpty, significant.count <= 4,
          let parsed = Int(String(decoding: Array(significant), as: UTF16.self)),
          parsed <= ReleaseCatalogLimits.numericCohortSize else {
        return nil
    }
    return parsed
}

/// A cohort as the server stores it: trimmed and lowercased, with numeric
/// cohorts in canonical form, such as `1` for `001`.
func normalizeCohortValue(_ cohort: String) -> String {
    let normalized = cohort.jsTrimmed.jsLowercased
    if let numericCohort = parseNumericCohortValue(normalized) {
        return String(numericCohort)
    }
    return normalized
}

private func numericCohortValue(_ cohort: String) -> Int? {
    parseNumericCohortValue(normalizeCohortValue(cohort))
}

func isCustomCohort(_ cohort: String) -> Bool {
    let normalized = normalizeCohortValue(cohort).utf16
    let isSlug = normalized.allSatisfy { unit in
        (unit >= 0x61 && unit <= 0x7A) || (unit >= 0x30 && unit <= 0x39) || unit == 0x2D
    }
    let isDigits = normalized.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    return !normalized.isEmpty
        && normalized.count <= ReleaseCatalogLimits.maxCohortLength
        && !isDigits
        && isSlug
}

func normalizeRolloutCohortCount(_ rolloutCohortCount: Double?) -> Int {
    guard let rolloutCohortCount else {
        return ReleaseCatalogLimits.numericCohortSize
    }
    // NaN rolls out to no one, as every comparison with it fails in JavaScript.
    if rolloutCohortCount.isNaN || rolloutCohortCount <= 0 {
        return 0
    }
    if rolloutCohortCount >= Double(ReleaseCatalogLimits.numericCohortSize) {
        return ReleaseCatalogLimits.numericCohortSize
    }
    return Int(rolloutCohortCount.rounded(.down))
}

private func positiveMod(_ value: Int, _ modulus: Int) -> Int {
    ((value % modulus) + modulus) % modulus
}

/// The protocol's 32-bit string hash over UTF-16 code units.
private func hashString(_ value: String) -> Int {
    var hash: Int32 = 0
    for unit in value.utf16 {
        hash = (hash &<< 5) &- hash &+ Int32(unit)
    }
    return Int(hash)
}

private func gcd(_ a: Int, _ b: Int) -> Int {
    var x = abs(a)
    var y = abs(b)
    while y != 0 {
        (x, y) = (y, x % y)
    }
    return x
}

private func modularInverse(_ value: Int, _ modulus: Int) -> Int {
    var t = 0
    var newT = 1
    var r = modulus
    var newR = positiveMod(value, modulus)
    while newR != 0 {
        let quotient = r / newR
        (t, newT) = (newT, t - quotient * newT)
        (r, newR) = (newR, r - quotient * newR)
    }
    // The multiplier is coprime with the cohort size, so r is 1 here.
    return positiveMod(t, modulus)
}

private func rolloutShuffleParameters(_ bundleId: String) -> (offset: Int, inverseMultiplier: Int) {
    let size = ReleaseCatalogLimits.numericCohortSize
    var multiplier = positiveMod(hashString("\(bundleId):multiplier"), 997)
    if multiplier == 0 {
        multiplier = 1
    }
    while gcd(multiplier, size) != 1 {
        multiplier = positiveMod(multiplier + 1, size)
        if multiplier == 0 {
            multiplier = 1
        }
    }
    let offset = positiveMod(hashString("\(bundleId):offset"), size)
    return (offset, modularInverse(multiplier, size))
}

private func numericCohortRolloutPosition(_ bundleId: String, _ cohortValue: Int) -> Int {
    let (offset, inverseMultiplier) = rolloutShuffleParameters(bundleId)
    return positiveMod(
        inverseMultiplier * (cohortValue - 1 - offset),
        ReleaseCatalogLimits.numericCohortSize
    )
}

func isCohortEligibleForUpdate(
    bundleId: String,
    cohort: String?,
    rolloutCohortCount: Double?,
    targetCohorts: [String]?
) -> Bool {
    let normalizedCohort = cohort.map(normalizeCohortValue)
    let normalizedTargetCohorts = (targetCohorts ?? []).map(normalizeCohortValue)

    if let normalizedCohort,
       normalizedTargetCohorts.contains(where: { $0.jsEquals(normalizedCohort) }) {
        return true
    }

    let normalizedRolloutCount = normalizeRolloutCohortCount(rolloutCohortCount)
    if normalizedRolloutCount <= 0 {
        return false
    }
    guard let normalizedCohort else {
        return normalizedRolloutCount >= ReleaseCatalogLimits.numericCohortSize
    }
    guard let numericCohort = numericCohortValue(normalizedCohort) else {
        return false
    }
    if normalizedRolloutCount >= ReleaseCatalogLimits.numericCohortSize {
        return true
    }
    return numericCohortRolloutPosition(bundleId, numericCohort) < normalizedRolloutCount
}

/// Whether a device in `cohort` may take the Release: it is targeted, rolled
/// out to the cohort, or rolled out fully to a custom cohort.
func isReleaseEligibleForCohort(
    releaseId: String,
    rolloutCohortCount: Double,
    targetCohorts: [String],
    cohort: String?
) -> Bool {
    if isCohortEligibleForUpdate(
        bundleId: releaseId,
        cohort: cohort,
        rolloutCohortCount: rolloutCohortCount,
        targetCohorts: targetCohorts
    ) {
        return true
    }
    guard let cohort else {
        return false
    }
    return isCustomCohort(normalizeCohortValue(cohort))
        && normalizeRolloutCohortCount(rolloutCohortCount) == ReleaseCatalogLimits.numericCohortSize
}

func isReleaseEligibleForCohort(_ release: ReleaseCatalogDescriptor, cohort: String?) -> Bool {
    isReleaseEligibleForCohort(
        releaseId: release.releaseId,
        rolloutCohortCount: Double(release.rolloutCohortCount),
        targetCohorts: release.targetCohorts,
        cohort: cohort
    )
}

// MARK: - Selection context hash

struct ReleaseSelectionContext {
    let activeBundleId: String?
    let activeReleaseId: String?
    let cohort: String?
    let minimumReleaseId: String
    let strategy: ReleaseStrategy
    let strategyValue: String
    let crashedBundleIds: [String]
}

/// Hashes what selection read, so a device reselects when its context changes
/// under the same catalog generation.
func createReleaseSelectionContextHash(_ context: ReleaseSelectionContext) -> String {
    let sorted = context.crashedBundleIds.sorted { $0.jsLess($1) }
    var crashedBundleIds = [String]()
    for bundleId in sorted where !(crashedBundleIds.last?.jsEquals(bundleId) ?? false) {
        crashedBundleIds.append(bundleId)
    }

    // JSON.stringify of the context, with the keys in this order.
    var json = CanonicalJSON()
    json.raw("{\"activeBundleId\":")
    json.nullableString(context.activeBundleId)
    json.raw(",\"activeReleaseId\":")
    json.nullableString(context.activeReleaseId)
    json.raw(",\"cohort\":")
    json.string(normalizeCohortValue(context.cohort ?? ""))
    json.raw(",\"crashedBundleIds\":[")
    for (index, bundleId) in crashedBundleIds.prefix(ReleaseCatalogLimits.maxCrashedBundles).enumerated() {
        if index > 0 {
            json.raw(",")
        }
        json.string(bundleId)
    }
    json.raw("],\"minimumReleaseId\":")
    json.string(context.minimumReleaseId)
    json.raw(",\"selectorSchemaVersion\":\(ReleaseCatalogLimits.schemaVersion),\"strategy\":")
    json.string(context.strategy.rawValue)
    json.raw(",\"strategyValue\":")
    json.string(context.strategyValue)
    json.raw("}")

    var first: UInt32 = 0x811C9DC5
    var second: UInt32 = 0x9E3779B9
    for code in json.units {
        first = (first ^ UInt32(code)) &* 0x01000193
        second = (second ^ UInt32(code)) &* 0x85EBCA6B
    }
    return "v1:" + hex8(first) + hex8(second)
}

private func hex8(_ value: UInt32) -> String {
    let digits = String(value, radix: 16)
    return String(repeating: "0", count: 8 - digits.count) + digits
}

/// UTF-16 code units of JSON written as JavaScript's JSON.stringify writes it.
private struct CanonicalJSON {
    private(set) var units = [UInt16]()

    mutating func raw(_ text: String) {
        units.append(contentsOf: text.utf16)
    }

    mutating func nullableString(_ value: String?) {
        if let value {
            string(value)
        } else {
            raw("null")
        }
    }

    mutating func string(_ value: String) {
        units.append(0x22)
        for unit in value.utf16 {
            switch unit {
            case 0x22: raw("\\\"")
            case 0x5C: raw("\\\\")
            case 0x08: raw("\\b")
            case 0x0C: raw("\\f")
            case 0x0A: raw("\\n")
            case 0x0D: raw("\\r")
            case 0x09: raw("\\t")
            case 0x00..<0x20:
                let digits = String(unit, radix: 16)
                raw("\\u" + String(repeating: "0", count: 4 - digits.count) + digits)
            default:
                // A Swift string holds no lone surrogates, which JSON.stringify
                // would escape, so every other code unit is written as is.
                units.append(unit)
            }
        }
        units.append(0x22)
    }
}

// MARK: - Desired Release

struct ReleaseSelectionInput {
    let builtInBundleId: String
    let currentBundleId: String
    let activeReleaseId: String?
    /// The Release of the bundle the app is running, which differs from
    /// `activeReleaseId` while a newer bundle is staged for the next launch.
    /// `nil` defaults to `activeReleaseId`; `.some(nil)` compares by
    /// `currentBundleId`.
    let runningReleaseId: String??
    let minimumReleaseId: String
    let cohort: String?
    let crashedBundleIds: [String]
}

enum DesiredReleaseStatus: String {
    case update = "UPDATE"
    case rollback = "ROLLBACK"
}

struct DesiredRelease {
    let kind: SelectionKind
    let releaseId: String?
    let bundleId: String
    let release: ReleaseCatalogDescriptor?
    let status: DesiredReleaseStatus
    /// Whether the device must apply this transition immediately: every
    /// rollback, and an update when a forced Release the device's cohort was
    /// eligible for lies after the running bundle's Release, up to and
    /// including the selected Release.
    let shouldForceUpdate: Bool
}

/// The Release the device should run under `catalog`, the built-in bundle when
/// the catalog leaves it none, or nil when it should keep what it runs.
func selectDesiredRelease(_ catalog: ReleaseCatalog, input: ReleaseSelectionInput) -> DesiredRelease? {
    let crashedBundleIds = Set(input.crashedBundleIds.map { Array($0.utf16) })
    let activeReleaseId = input.activeReleaseId
    let hasActiveBundle = !input.currentBundleId.jsEquals(input.builtInBundleId)
    let runningReleaseId: String? = input.runningReleaseId ?? activeReleaseId

    func safeBundleId(_ release: ReleaseCatalogDescriptor) -> String? {
        guard let bundleId = release.bundleId,
              !crashedBundleIds.contains(Array(bundleId.utf16)),
              !bundleId.jsLess(input.minimumReleaseId) else {
            return nil
        }
        return bundleId
    }

    func isNewerThanRunning(_ release: ReleaseCatalogDescriptor) -> Bool {
        if let runningReleaseId {
            return runningReleaseId.jsLess(release.releaseId)
        }
        guard let bundleId = release.bundleId else {
            return false
        }
        return input.currentBundleId.jsLess(bundleId)
    }

    // `releases` keeps only the newest few Bundles, so the forced Releases an
    // update carries the device past are read from the complete spine. A
    // forced Release of the running bundle is already satisfied, and one below
    // the native floor is older than what the binary ships.
    func passesForcedRelease(_ selected: ReleaseCatalogDescriptor) -> Bool {
        ([selected] + catalog.rollbackReleases).contains { passed in
            guard passed.shouldForceUpdate, let bundleId = passed.bundleId else {
                return false
            }
            return !bundleId.jsLess(input.minimumReleaseId)
                && !bundleId.jsEquals(input.currentBundleId)
                && !selected.releaseId.jsLess(passed.releaseId)
                && isNewerThanRunning(passed)
                && isReleaseEligibleForCohort(passed, cohort: input.cohort)
        }
    }

    func desiredBundle(_ release: ReleaseCatalogDescriptor, bundleId: String, status: DesiredReleaseStatus) -> DesiredRelease {
        DesiredRelease(
            kind: .bundle,
            releaseId: release.releaseId,
            bundleId: bundleId,
            release: release,
            status: status,
            shouldForceUpdate: status == .rollback || passesForcedRelease(release)
        )
    }

    for release in catalog.releases {
        guard isReleaseEligibleForCohort(release, cohort: input.cohort) else {
            continue
        }
        if let activeReleaseId {
            if !activeReleaseId.jsLess(release.releaseId) {
                continue
            }
        } else if hasActiveBundle {
            guard let bundleId = release.bundleId, input.currentBundleId.jsLess(bundleId) else {
                continue
            }
        }
        if let bundleId = safeBundleId(release) {
            return desiredBundle(release, bundleId: bundleId, status: .update)
        }
    }

    if activeReleaseId != nil || hasActiveBundle {
        let rollbackReleases = catalog.rollbackReleases
        let current = rollbackReleases.first { release in
            if let activeReleaseId {
                return release.releaseId.jsEquals(activeReleaseId)
            }
            return release.bundleId.jsEquals(input.currentBundleId)
        }
        if let current, let bundleId = safeBundleId(current),
           isReleaseEligibleForCohort(current, cohort: input.cohort) {
            return desiredBundle(current, bundleId: bundleId, status: .update)
        }

        for release in rollbackReleases {
            guard let bundleId = safeBundleId(release) else {
                continue
            }
            let isOlder = activeReleaseId.map { release.releaseId.jsLess($0) }
                ?? bundleId.jsLess(input.currentBundleId)
            if isOlder {
                return desiredBundle(release, bundleId: bundleId, status: .rollback)
            }
        }

        if !input.minimumReleaseId.jsLess(input.currentBundleId) {
            return nil
        }
    }

    guard catalog.fallbackPolicy.jsEquals(ReleaseCatalogLimits.fallbackPolicy) else {
        return nil
    }
    return DesiredRelease(
        kind: .builtin,
        releaseId: nil,
        bundleId: input.builtInBundleId,
        release: nil,
        status: .rollback,
        shouldForceUpdate: true
    )
}

// MARK: - Transition authorization

enum ReleaseTransitionReason: String {
    case firstAuthenticatedSelection = "FIRST_AUTHENTICATED_SELECTION"
    case newerPolicy = "NEWER_POLICY"
    case contextReselection = "CONTEXT_RESELECTION"
    case explicitScopeSwitch = "EXPLICIT_SCOPE_SWITCH"
    case backwardNotAuthorized = "BACKWARD_NOT_AUTHORIZED"
    case emptyTargetScope = "EMPTY_TARGET_SCOPE"
    case staleGeneration = "STALE_GENERATION"
    case unsolicitedScope = "UNSOLICITED_SCOPE"
}

struct ReleaseTransitionAuthorization: Equatable {
    let authorized: Bool
    let reason: ReleaseTransitionReason
}

/// Whether the device may move from its active selection to `desired`.
func authorizeReleaseTransition(
    active: PersistedSelection?,
    desired: PersistedSelection,
    explicitScopeSwitch: Bool
) -> ReleaseTransitionAuthorization {
    guard let active, active.scopeKey != nil, let activeGeneration = active.generation else {
        return ReleaseTransitionAuthorization(authorized: true, reason: .firstAuthenticatedSelection)
    }

    if !desired.catalogId.jsEquals(active.catalogId) || !desired.scopeKey.jsEquals(active.scopeKey) {
        if !explicitScopeSwitch {
            return ReleaseTransitionAuthorization(authorized: false, reason: .unsolicitedScope)
        }
        if desired.releaseId == nil || desired.kind.jsEquals(SelectionKind.builtin.rawValue) {
            return ReleaseTransitionAuthorization(authorized: false, reason: .emptyTargetScope)
        }
        return ReleaseTransitionAuthorization(authorized: true, reason: .explicitScopeSwitch)
    }

    guard let desiredGeneration = desired.generation, desiredGeneration >= activeGeneration else {
        return ReleaseTransitionAuthorization(authorized: false, reason: .staleGeneration)
    }
    if desiredGeneration > activeGeneration {
        return ReleaseTransitionAuthorization(authorized: true, reason: .newerPolicy)
    }
    if !desired.selectionContextHash.jsEquals(active.selectionContextHash) {
        return ReleaseTransitionAuthorization(authorized: true, reason: .contextReselection)
    }
    return ReleaseTransitionAuthorization(authorized: false, reason: .backwardNotAuthorized)
}
