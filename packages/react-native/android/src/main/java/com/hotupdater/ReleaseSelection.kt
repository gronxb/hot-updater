package com.hotupdater

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/*
 * Release selection, ported from @hot-updater/protocol (releaseCatalog.ts and
 * rollout.ts). The shared conformance fixture in
 * packages/test-utils/fixtures/release-selection-conformance.json pins every
 * result to the TypeScript one, so change both together. Strings compare by
 * UTF-16 code units, as JavaScript's `<` and `>` do.
 */

internal enum class SelectionKind {
    BUNDLE,
    BUILTIN,
}

internal enum class DesiredReleaseStatus {
    UPDATE,
    ROLLBACK,
}

/** Which Release the app is running, which differs from the active one while a newer bundle is staged. */
internal sealed class RunningReleaseId {
    /** The running Release is the active Release. */
    object SameAsActive : RunningReleaseId()

    /** The running Release, where null compares by the current bundle ID. */
    data class Explicit(
        val releaseId: String?,
    ) : RunningReleaseId()
}

internal data class ReleaseSelectionInput(
    val builtInBundleId: String,
    val currentBundleId: String,
    val activeReleaseId: String?,
    val runningReleaseId: RunningReleaseId = RunningReleaseId.SameAsActive,
    val minimumReleaseId: String,
    val cohort: String?,
    val crashedBundleIds: List<String>,
)

internal data class ReleaseSelectionContextInput(
    val activeBundleId: String?,
    val activeReleaseId: String?,
    val cohort: String?,
    val minimumReleaseId: String,
    val strategy: ReleaseStrategy,
    val strategyValue: String,
    val crashedBundleIds: List<String>,
)

internal data class DesiredRelease(
    val kind: SelectionKind,
    val releaseId: String?,
    val bundleId: String,
    val release: ReleaseCatalogDescriptor?,
    val status: DesiredReleaseStatus,
    /**
     * Whether the device must apply this transition immediately: every rollback,
     * and an update when a forced Release the device's cohort was eligible for
     * lies after the running bundle's Release, up to and including the selected
     * Release.
     */
    val shouldForceUpdate: Boolean,
)

internal enum class ReleaseTransitionReason(
    val authorized: Boolean,
) {
    FIRST_AUTHENTICATED_SELECTION(true),
    NEWER_POLICY(true),
    CONTEXT_RESELECTION(true),
    EXPLICIT_SCOPE_SWITCH(true),
    BACKWARD_NOT_AUTHORIZED(false),
    EMPTY_TARGET_SCOPE(false),
    STALE_GENERATION(false),
    UNSOLICITED_SCOPE(false),
}

internal object ReleaseSelector {
    const val NUMERIC_COHORT_SIZE = 1000
    const val DEFAULT_ROLLOUT_COHORT_COUNT = NUMERIC_COHORT_SIZE
    const val MAX_COHORT_LENGTH = 64
    private const val SELECTION_KIND_BUILTIN = "BUILTIN"

    private val CUSTOM_COHORT_PATTERN = Regex("[a-z0-9-]+")

    fun normalizeCohortValue(cohort: String): String {
        val normalized = cohort.trimJsWhitespace().lowercase(Locale.ROOT)
        return parseNumericCohortValue(normalized)?.toString() ?: normalized
    }

    fun normalizeRolloutCohortCount(rolloutCohortCount: Double?): Int {
        if (rolloutCohortCount == null) return DEFAULT_ROLLOUT_COHORT_COUNT
        if (rolloutCohortCount <= 0) return 0
        if (rolloutCohortCount >= NUMERIC_COHORT_SIZE) return NUMERIC_COHORT_SIZE
        return floor(rolloutCohortCount).toInt()
    }

    fun isCustomCohort(cohort: String): Boolean {
        val normalized = normalizeCohortValue(cohort)
        return normalized.isNotEmpty() &&
            normalized.length <= MAX_COHORT_LENGTH &&
            !isAsciiDigits(normalized) &&
            CUSTOM_COHORT_PATTERN.matches(normalized)
    }

    fun isCohortEligibleForUpdate(
        bundleId: String,
        cohort: String?,
        rolloutCohortCount: Double?,
        targetCohorts: List<String>?,
    ): Boolean {
        val normalizedCohort = cohort?.let(::normalizeCohortValue)
        val normalizedTargetCohorts = targetCohorts?.map(::normalizeCohortValue) ?: emptyList()

        if (normalizedCohort != null && normalizedTargetCohorts.contains(normalizedCohort)) {
            return true
        }

        val normalizedRolloutCount = normalizeRolloutCohortCount(rolloutCohortCount)
        if (normalizedRolloutCount <= 0) return false
        if (normalizedCohort == null) return normalizedRolloutCount >= NUMERIC_COHORT_SIZE

        val numericCohort = parseNumericCohortValue(normalizeCohortValue(normalizedCohort)) ?: return false
        if (normalizedRolloutCount >= NUMERIC_COHORT_SIZE) return true

        return getNumericCohortRolloutPosition(bundleId, numericCohort) < normalizedRolloutCount
    }

    fun isReleaseEligibleForCohort(
        releaseId: String,
        rolloutCohortCount: Double,
        targetCohorts: List<String>,
        cohort: String?,
    ): Boolean {
        if (isCohortEligibleForUpdate(releaseId, cohort, rolloutCohortCount, targetCohorts)) {
            return true
        }

        return cohort != null &&
            isCustomCohort(normalizeCohortValue(cohort)) &&
            normalizeRolloutCohortCount(rolloutCohortCount) == NUMERIC_COHORT_SIZE
    }

    fun isReleaseEligibleForCohort(
        release: ReleaseCatalogDescriptor,
        cohort: String?,
    ): Boolean =
        isReleaseEligibleForCohort(
            releaseId = release.releaseId,
            rolloutCohortCount = release.rolloutCohortCount.toDouble(),
            targetCohorts = release.targetCohorts,
            cohort = cohort,
        )

    fun createSelectionContextHash(input: ReleaseSelectionContextInput): String {
        val crashedBundleIds =
            input.crashedBundleIds
                .distinct()
                .sorted()
                .take(ReleaseCatalogs.MAX_CRASHED_BUNDLES)
        // JSON.stringify of the same keys in the same order.
        val canonical =
            buildString {
                append("{\"activeBundleId\":")
                appendJsonString(input.activeBundleId)
                append(",\"activeReleaseId\":")
                appendJsonString(input.activeReleaseId)
                append(",\"cohort\":")
                appendJsonString(normalizeCohortValue(input.cohort ?: ""))
                append(",\"crashedBundleIds\":[")
                crashedBundleIds.forEachIndexed { index, bundleId ->
                    if (index > 0) append(',')
                    appendJsonString(bundleId)
                }
                append("],\"minimumReleaseId\":")
                appendJsonString(input.minimumReleaseId)
                append(",\"selectorSchemaVersion\":")
                append(ReleaseCatalogs.SCHEMA_VERSION)
                append(",\"strategy\":")
                appendJsonString(input.strategy.name)
                append(",\"strategyValue\":")
                appendJsonString(input.strategyValue)
                append('}')
            }
        return hashSelectionContext(canonical)
    }

    fun selectDesiredRelease(
        catalog: ReleaseCatalog,
        input: ReleaseSelectionInput,
    ): DesiredRelease? {
        val crashedBundleIds = input.crashedBundleIds.toHashSet()
        val activeReleaseId = input.activeReleaseId
        val hasActiveBundle = input.currentBundleId != input.builtInBundleId

        fun isSafeBundleRelease(release: ReleaseCatalogDescriptor): Boolean {
            val bundleId = release.bundleId ?: return false
            return !crashedBundleIds.contains(bundleId) && bundleId >= input.minimumReleaseId
        }

        val running = input.runningReleaseId
        val runningReleaseId = if (running is RunningReleaseId.Explicit) running.releaseId else activeReleaseId

        fun isNewerThanRunning(release: ReleaseCatalogDescriptor): Boolean {
            if (runningReleaseId != null) return release.releaseId > runningReleaseId
            val bundleId = release.bundleId ?: return false
            return bundleId > input.currentBundleId
        }

        // `releases` keeps only the newest few Bundles, so the forced Releases an
        // update carries the device past are read from the complete spine. A
        // forced Release of the running bundle is already satisfied, and one
        // below the native floor is older than what the binary ships.
        fun passesForcedRelease(selected: ReleaseCatalogDescriptor): Boolean =
            (listOf(selected) + catalog.rollbackReleases).any { passed ->
                val bundleId = passed.bundleId
                passed.shouldForceUpdate &&
                    bundleId != null &&
                    bundleId >= input.minimumReleaseId &&
                    bundleId != input.currentBundleId &&
                    passed.releaseId <= selected.releaseId &&
                    isNewerThanRunning(passed) &&
                    isReleaseEligibleForCohort(passed, input.cohort)
            }

        fun desiredBundle(
            release: ReleaseCatalogDescriptor,
            status: DesiredReleaseStatus,
        ): DesiredRelease =
            DesiredRelease(
                kind = SelectionKind.BUNDLE,
                releaseId = release.releaseId,
                bundleId = requireNotNull(release.bundleId),
                release = release,
                status = status,
                shouldForceUpdate = status == DesiredReleaseStatus.ROLLBACK || passesForcedRelease(release),
            )

        for (release in catalog.releases) {
            if (!isReleaseEligibleForCohort(release, input.cohort)) continue

            val bundleId = release.bundleId
            val notNewer =
                if (activeReleaseId != null) {
                    release.releaseId <= activeReleaseId
                } else {
                    hasActiveBundle && (bundleId == null || bundleId <= input.currentBundleId)
                }
            if (notNewer) continue

            if (isSafeBundleRelease(release)) {
                return desiredBundle(release, DesiredReleaseStatus.UPDATE)
            }
        }

        if (activeReleaseId != null || hasActiveBundle) {
            val rollbackReleases = catalog.rollbackReleases
            val current =
                rollbackReleases.firstOrNull { release ->
                    release.releaseId == activeReleaseId ||
                        (activeReleaseId == null && release.bundleId == input.currentBundleId)
                }
            if (current != null && isSafeBundleRelease(current) && isReleaseEligibleForCohort(current, input.cohort)) {
                return desiredBundle(current, DesiredReleaseStatus.UPDATE)
            }

            val rollback =
                rollbackReleases.firstOrNull { release ->
                    isSafeBundleRelease(release) &&
                        if (activeReleaseId != null) {
                            release.releaseId < activeReleaseId
                        } else {
                            requireNotNull(release.bundleId) < input.currentBundleId
                        }
                }
            if (rollback != null) {
                return desiredBundle(rollback, DesiredReleaseStatus.ROLLBACK)
            }

            if (input.currentBundleId <= input.minimumReleaseId) {
                return null
            }
        }

        if (catalog.fallbackPolicy != ReleaseCatalogs.FALLBACK_POLICY) {
            return null
        }

        return DesiredRelease(
            kind = SelectionKind.BUILTIN,
            releaseId = null,
            bundleId = input.builtInBundleId,
            release = null,
            status = DesiredReleaseStatus.ROLLBACK,
            shouldForceUpdate = true,
        )
    }

    fun authorizeReleaseTransition(
        active: PersistedSelection?,
        desired: PersistedSelection,
        explicitScopeSwitch: Boolean,
    ): ReleaseTransitionReason {
        val activeGeneration = active?.generation
        if (active?.scopeKey == null || activeGeneration == null) {
            return ReleaseTransitionReason.FIRST_AUTHENTICATED_SELECTION
        }

        if (desired.catalogId != active.catalogId || desired.scopeKey != active.scopeKey) {
            if (!explicitScopeSwitch) return ReleaseTransitionReason.UNSOLICITED_SCOPE
            if (desired.releaseId == null || desired.kind == SELECTION_KIND_BUILTIN) {
                return ReleaseTransitionReason.EMPTY_TARGET_SCOPE
            }
            return ReleaseTransitionReason.EXPLICIT_SCOPE_SWITCH
        }

        val desiredGeneration = desired.generation
        if (desiredGeneration == null || desiredGeneration < activeGeneration) {
            return ReleaseTransitionReason.STALE_GENERATION
        }
        if (desiredGeneration > activeGeneration) {
            return ReleaseTransitionReason.NEWER_POLICY
        }
        if (desired.selectionContextHash != active.selectionContextHash) {
            return ReleaseTransitionReason.CONTEXT_RESELECTION
        }
        return ReleaseTransitionReason.BACKWARD_NOT_AUTHORIZED
    }

    private fun isAsciiDigits(value: String): Boolean = value.isNotEmpty() && value.all { it in '0'..'9' }

    private fun parseNumericCohortValue(cohort: String): Int? {
        if (!isAsciiDigits(cohort)) return null
        val digits = cohort.trimStart('0')
        if (digits.length > 4) return null
        val parsed = if (digits.isEmpty()) 0 else digits.toInt()
        return if (parsed in 1..NUMERIC_COHORT_SIZE) parsed else null
    }

    /** rollout.ts `hashString`: a 32-bit wrapping hash of UTF-16 code units. */
    private fun hashString(value: String): Int {
        var hash = 0
        for (char in value) {
            hash = (hash shl 5) - hash + char.code
        }
        return hash
    }

    private fun positiveMod(
        value: Int,
        modulus: Int,
    ): Int = ((value % modulus) + modulus) % modulus

    private fun gcd(
        a: Int,
        b: Int,
    ): Int {
        var x = abs(a)
        var y = abs(b)
        while (y != 0) {
            val next = x % y
            x = y
            y = next
        }
        return x
    }

    private fun modularInverse(
        value: Int,
        modulus: Int,
    ): Int {
        var t = 0
        var newT = 1
        var r = modulus
        var newR = positiveMod(value, modulus)
        while (newR != 0) {
            val quotient = r / newR
            val nextT = t - quotient * newT
            t = newT
            newT = nextT
            val nextR = r - quotient * newR
            r = newR
            newR = nextR
        }
        check(r <= 1) { "No modular inverse for $value mod $modulus" }
        return positiveMod(t, modulus)
    }

    private fun getNumericCohortRolloutPosition(
        bundleId: String,
        cohortValue: Int,
    ): Int {
        require(cohortValue in 1..NUMERIC_COHORT_SIZE) { "Invalid numeric cohort: $cohortValue" }

        var multiplier = positiveMod(hashString("$bundleId:multiplier"), 997)
        if (multiplier == 0) multiplier = 1
        while (gcd(multiplier, NUMERIC_COHORT_SIZE) != 1) {
            multiplier = positiveMod(multiplier + 1, NUMERIC_COHORT_SIZE)
            if (multiplier == 0) multiplier = 1
        }
        val offset = positiveMod(hashString("$bundleId:offset"), NUMERIC_COHORT_SIZE)
        val inverseMultiplier = modularInverse(multiplier, NUMERIC_COHORT_SIZE)

        return positiveMod(inverseMultiplier * (cohortValue - 1 - offset), NUMERIC_COHORT_SIZE)
    }

    /** Two 32-bit multiplicative hashes of the UTF-16 code units, as `Math.imul` computes them. */
    private fun hashSelectionContext(value: String): String {
        var first = 0x811c9dc5L.toInt()
        var second = 0x9e3779b9L.toInt()
        for (char in value) {
            val code = char.code
            first = (first xor code) * 0x01000193
            second = (second xor code) * 0x85ebca6bL.toInt()
        }
        return "v1:" + Integer.toHexString(first).padStart(8, '0') + Integer.toHexString(second).padStart(8, '0')
    }

    /** Appends [value] as `JSON.stringify` writes it, or `null`. */
    private fun StringBuilder.appendJsonString(value: String?) {
        if (value == null) {
            append("null")
            return
        }
        append('"')
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char == '"') {
                append("\\\"")
            } else if (char == '\\') {
                append("\\\\")
            } else if (char == '\b') {
                append("\\b")
            } else if (char == '\u000c') {
                append("\\f")
            } else if (char == '\n') {
                append("\\n")
            } else if (char == '\r') {
                append("\\r")
            } else if (char == '\t') {
                append("\\t")
            } else if (char.code < 0x20) {
                appendUnicodeEscape(char)
            } else if (Character.isHighSurrogate(char)) {
                val next = value.getOrNull(index + 1)
                if (next != null && Character.isLowSurrogate(next)) {
                    append(char)
                    append(next)
                    index += 1
                } else {
                    appendUnicodeEscape(char)
                }
            } else if (Character.isLowSurrogate(char)) {
                appendUnicodeEscape(char)
            } else {
                append(char)
            }
            index += 1
        }
        append('"')
    }

    private fun StringBuilder.appendUnicodeEscape(char: Char) {
        append("\\u")
        append(Integer.toHexString(char.code).padStart(4, '0'))
    }
}
