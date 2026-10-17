package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import kotlin.math.abs
import kotlin.math.floor

/*
 * The release catalog as a device accepts it, ported from @hot-updater/protocol
 * (releaseCatalog.ts, releaseCatalogScope.ts, releaseCatalogWire.ts, uuid.ts and
 * appVersion.ts). The shared conformance fixture in
 * packages/test-utils/fixtures/release-selection-conformance.json pins every
 * result to the TypeScript one, so change both together.
 */

internal enum class ReleaseStrategy {
    APP_VERSION,
    FINGERPRINT,
}

internal data class ReleaseCatalogDescriptor(
    val releaseId: String,
    val kind: String,
    val bundleId: String?,
    val rolloutCohortCount: Int,
    val targetCohorts: List<String>,
    val shouldForceUpdate: Boolean,
    val message: String?,
)

internal data class ReleaseCatalog(
    val schemaVersion: Int,
    val catalogId: String,
    val scopeKey: String,
    val generation: Long,
    val catalogHash: String,
    val fallbackPolicy: String,
    /** Release descriptors ordered newest first. */
    val releases: List<ReleaseCatalogDescriptor>,
    /**
     * Enabled compatible Releases ordered newest first, where a device keeps its
     * active Release or rolls back to the newest Release before it.
     */
    val rollbackReleases: List<ReleaseCatalogDescriptor>,
)

/** A release catalog scope: the one a client asks for, or the one a scope key names. */
internal sealed class ReleaseCatalogScope {
    abstract val platform: String
    abstract val channelKey: String
    abstract val strategy: ReleaseStrategy

    data class AppVersion(
        override val platform: String,
        override val channelKey: String,
    ) : ReleaseCatalogScope() {
        override val strategy: ReleaseStrategy get() = ReleaseStrategy.APP_VERSION
    }

    data class Fingerprint(
        override val platform: String,
        override val channelKey: String,
        val fingerprintHash: String,
    ) : ReleaseCatalogScope() {
        override val strategy: ReleaseStrategy get() = ReleaseStrategy.FINGERPRINT
    }
}

internal object ReleaseCatalogs {
    const val SCHEMA_VERSION = 1
    const val FALLBACK_POLICY = "BUILTIN_IF_ACTIVE_INELIGIBLE"
    const val KIND_BUNDLE = "BUNDLE"
    const val MAX_CRASHED_BUNDLES = 10
    const val MAX_TARGET_COHORTS_PER_RELEASE = 100
    const val MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE = 512
    const val MAX_COMPILED_CATALOG_BYTES = 256 * 1024

    /** The largest release catalog response body a client accepts, in UTF-8 bytes. */
    const val MAX_RELEASE_CATALOG_WIRE_BYTES = MAX_COMPILED_CATALOG_BYTES * 2 + 4 * 1024

    private const val MAX_SAFE_INTEGER = 9007199254740991.0
    private const val MAX_CATALOG_SEGMENT_LENGTH = 255
    private const val MAX_CHANNEL_CODE_POINTS = 255
    private const val BASE64URL_ALPHABET =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    private val UUID_V7_PATTERN =
        Regex("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val CATALOG_HASH_PATTERN = Regex("sha256:[0-9a-f]{64}")
    private val CATALOG_SEGMENT_PATTERN = Regex("[A-Za-z0-9._~-]+")
    private val BASE64URL_PATTERN = Regex("[A-Za-z0-9_-]*")

    // verkit's coerce pattern. JavaScript `\d` is ASCII and `$` is the end of input.
    private val APP_VERSION_COERCE_PATTERN =
        Regex("(^|[^0-9])([0-9]{1,16})(?:\\.([0-9]{1,16}))?(?:\\.([0-9]{1,16}))?(?:\\z|[^0-9])")

    fun isUuidV7(value: Any?): Boolean = value is String && UUID_V7_PATTERN.matches(value)

    /**
     * The form of an app version that the device and the server compare:
     * `major.minor.patch` of the first version in [appVersion], or null when it
     * holds none.
     */
    fun canonicalizeAppVersion(appVersion: String): String? {
        val match = APP_VERSION_COERCE_PATTERN.find(appVersion) ?: return null
        val parts =
            listOf(
                match.groupValues[2],
                match.groups[3]?.value ?: "0",
                match.groups[4]?.value ?: "0",
            )
        val numbers = mutableListOf<Long>()
        for (part in parts) {
            if (part.length > 1 && part[0] == '0') return null
            val number = part.toLong()
            if (number > MAX_SAFE_INTEGER.toLong()) return null
            numbers.add(number)
        }
        return numbers.joinToString(".")
    }

    /** The length of [value] in UTF-8 bytes, counting a lone surrogate as 3 bytes. */
    fun utf8ByteLength(value: String): Int {
        var bytes = 0
        var index = 0
        while (index < value.length) {
            val code = value[index].code
            if (code <= 0x7f) {
                bytes += 1
            } else if (code <= 0x7ff) {
                bytes += 2
            } else if (
                code in 0xd800..0xdbff &&
                index + 1 < value.length &&
                value[index + 1].code in 0xdc00..0xdfff
            ) {
                bytes += 4
                index += 1
            } else {
                bytes += 3
            }
            index += 1
        }
        return bytes
    }

    fun normalizeChannelName(channel: String): String = Normalizer.normalize(channel.trimJsWhitespace(), Normalizer.Form.NFC)

    fun assertCanonicalChannelName(channel: String) {
        val normalized = normalizeChannelName(channel)
        require(normalized.isNotEmpty() && normalized == channel) {
            "Channel name must be non-empty, trimmed, and NFC-normalized"
        }
        require(normalized.codePointCount(0, normalized.length) <= MAX_CHANNEL_CODE_POINTS) {
            "Channel name must not exceed 255 characters"
        }
    }

    fun encodeChannelKey(channel: String): String {
        assertCanonicalChannelName(channel)
        return base64UrlEncode(encodeUtf8(channel))
    }

    fun decodeChannelKey(channelKey: String): String {
        val channel = decodeUtf8(base64UrlDecode(channelKey))
        assertCanonicalChannelName(channel)
        require(encodeChannelKey(channel) == channelKey) { "Channel key is not canonically encoded" }
        return channel
    }

    fun createScopeKey(scope: ReleaseCatalogScope): String {
        decodeChannelKey(scope.channelKey)
        return when (scope) {
            is ReleaseCatalogScope.AppVersion -> {
                "v1:app-version:${scope.platform}:${scope.channelKey}"
            }

            is ReleaseCatalogScope.Fingerprint -> {
                assertCatalogSegment(scope.fingerprintHash, "Fingerprint hash")
                "v1:fingerprint:${scope.platform}:${scope.channelKey}:${scope.fingerprintHash}"
            }
        }
    }

    fun parseScopeKey(scopeKey: String): ReleaseCatalogScope {
        val segments = scopeKey.split(":")
        val version = segments[0]
        val strategy = segments.getOrNull(1)
        val platform = segments.getOrNull(2)?.takeIf { it == "ios" || it == "android" }
        val channelKey = segments.getOrNull(3)
        require(version == "v1" && platform != null && channelKey != null) {
            "Invalid release catalog scope key"
        }

        val scope =
            if (strategy == "app-version" && segments.size == 4) {
                ReleaseCatalogScope.AppVersion(platform = platform, channelKey = channelKey)
            } else if (strategy == "fingerprint" && segments.size == 5) {
                ReleaseCatalogScope.Fingerprint(
                    platform = platform,
                    channelKey = channelKey,
                    fingerprintHash = segments[4],
                )
            } else {
                throw IllegalArgumentException("Invalid release catalog scope key")
            }

        require(createScopeKey(scope) == scopeKey) { "Release catalog scope key is not canonical" }
        return scope
    }

    /** Whether [scopeKey] names the [expected] scope. */
    fun hasExpectedScope(
        scopeKey: String,
        expected: ReleaseCatalogScope,
    ): Boolean =
        try {
            parseScopeKey(scopeKey) == expected
        } catch (_: IllegalArgumentException) {
            false
        }

    /**
     * Parses a release catalog response body as a client accepts it: within the
     * wire limit, in the schema's shape, for the expected scope, and within the
     * cohort limits. Any other body is null.
     */
    fun parse(
        body: String,
        expectedScope: ReleaseCatalogScope,
    ): ReleaseCatalog? {
        if (utf8ByteLength(body) > MAX_RELEASE_CATALOG_WIRE_BYTES) return null
        return try {
            // As JSON.parse reads it, which org.json's parser does not.
            val root = StrictJson.parse(body) as? JSONObject ?: return null
            val catalog = parseCatalogObject(root) ?: return null
            if (!hasExpectedScope(catalog.scopeKey, expectedScope)) return null
            val distinctTargetCohorts =
                (catalog.releases + catalog.rollbackReleases)
                    .flatMap { it.targetCohorts }
                    .toSet()
            if (distinctTargetCohorts.size > MAX_DISTINCT_TARGET_COHORTS_PER_SCOPE) return null
            catalog
        } catch (_: Exception) {
            null
        } catch (_: StackOverflowError) {
            // org.json parses recursively; JSON.parse's RangeError on deep nesting is null too.
            null
        }
    }

    private fun parseCatalogObject(json: JSONObject): ReleaseCatalog? {
        val schemaVersion = safeInteger(json.opt("schemaVersion"))
        val catalogId = json.opt("catalogId") as? String
        val scopeKey = json.opt("scopeKey") as? String
        val generation = safeInteger(json.opt("generation"))
        val catalogHash = json.opt("catalogHash") as? String
        val releases = (json.opt("releases") as? JSONArray)?.let(::parseDescriptors)
        val rollbackReleases = (json.opt("rollbackReleases") as? JSONArray)?.let(::parseDescriptors)
        if (
            schemaVersion != SCHEMA_VERSION.toLong() ||
            catalogId.isNullOrEmpty() ||
            scopeKey == null ||
            generation == null ||
            generation < 1 ||
            catalogHash == null ||
            !CATALOG_HASH_PATTERN.matches(catalogHash) ||
            json.opt("fallbackPolicy") != FALLBACK_POLICY ||
            releases == null ||
            rollbackReleases == null
        ) {
            return null
        }
        return ReleaseCatalog(
            schemaVersion = SCHEMA_VERSION,
            catalogId = catalogId,
            scopeKey = scopeKey,
            generation = generation,
            catalogHash = catalogHash,
            fallbackPolicy = FALLBACK_POLICY,
            releases = releases,
            rollbackReleases = rollbackReleases,
        )
    }

    private fun parseDescriptors(array: JSONArray): List<ReleaseCatalogDescriptor>? {
        val descriptors = ArrayList<ReleaseCatalogDescriptor>(array.length())
        for (index in 0 until array.length()) {
            descriptors.add(parseDescriptor(array.opt(index)) ?: return null)
        }
        return descriptors
    }

    private fun parseDescriptor(value: Any?): ReleaseCatalogDescriptor? {
        if (value !is JSONObject) return null
        val releaseId = value.opt("releaseId")
        val bundleId = value.opt("bundleId") as? String
        val rolloutCohortCount = safeInteger(value.opt("rolloutCohortCount"))
        val targetCohorts = (value.opt("targetCohorts") as? JSONArray)?.let(::parseStrings)
        val shouldForceUpdate = value.opt("shouldForceUpdate") as? Boolean
        val message = value.opt("message")
        if (
            !isUuidV7(releaseId) ||
            value.opt("kind") != KIND_BUNDLE ||
            bundleId == null ||
            rolloutCohortCount == null ||
            rolloutCohortCount < 0 ||
            rolloutCohortCount > ReleaseSelector.NUMERIC_COHORT_SIZE ||
            targetCohorts == null ||
            targetCohorts.size > MAX_TARGET_COHORTS_PER_RELEASE ||
            shouldForceUpdate == null ||
            (message != JSONObject.NULL && message !is String)
        ) {
            return null
        }
        return ReleaseCatalogDescriptor(
            releaseId = releaseId as String,
            kind = KIND_BUNDLE,
            bundleId = bundleId,
            rolloutCohortCount = rolloutCohortCount.toInt(),
            targetCohorts = targetCohorts,
            shouldForceUpdate = shouldForceUpdate,
            message = message as? String,
        )
    }

    private fun parseStrings(array: JSONArray): List<String>? {
        val strings = ArrayList<String>(array.length())
        for (index in 0 until array.length()) {
            strings.add(array.opt(index) as? String ?: return null)
        }
        return strings
    }

    /**
     * The value when `Number.isSafeInteger` holds for it. JavaScript reads every
     * JSON number as a double, so `3.0` and `3e0` are safe integers. org.json
     * returns Integer, Long, Double, BigInteger or BigDecimal depending on the
     * literal and the org.json flavor, so each is read through its double.
     */
    private fun safeInteger(value: Any?): Long? {
        if (value !is Number) return null
        val number = value.toDouble()
        if (number.isNaN() || number.isInfinite() || number != floor(number) || abs(number) > MAX_SAFE_INTEGER) {
            return null
        }
        return number.toLong()
    }

    private fun assertCatalogSegment(
        value: String,
        name: String,
    ) {
        require(
            value.isNotEmpty() &&
                value.length <= MAX_CATALOG_SEGMENT_LENGTH &&
                CATALOG_SEGMENT_PATTERN.matches(value),
        ) {
            "$name must be 1-$MAX_CATALOG_SEGMENT_LENGTH URL-safe ASCII characters"
        }
    }

    private fun encodeUtf8(value: String): List<Int> {
        val bytes = ArrayList<Int>(value.length)
        var index = 0
        while (index < value.length) {
            val codePoint = value.codePointAt(index)
            if (codePoint <= 0x7f) {
                bytes.add(codePoint)
            } else if (codePoint <= 0x7ff) {
                bytes.add(0xc0 or (codePoint shr 6))
                bytes.add(0x80 or (codePoint and 0x3f))
            } else if (codePoint <= 0xffff) {
                bytes.add(0xe0 or (codePoint shr 12))
                bytes.add(0x80 or ((codePoint shr 6) and 0x3f))
                bytes.add(0x80 or (codePoint and 0x3f))
            } else {
                bytes.add(0xf0 or (codePoint shr 18))
                bytes.add(0x80 or ((codePoint shr 12) and 0x3f))
                bytes.add(0x80 or ((codePoint shr 6) and 0x3f))
                bytes.add(0x80 or (codePoint and 0x3f))
            }
            index += Character.charCount(codePoint)
        }
        return bytes
    }

    private fun decodeUtf8(bytes: List<Int>): String {
        val result = StringBuilder()
        var index = 0
        while (index < bytes.size) {
            val first = bytes[index++]
            var codePoint: Int
            val continuationCount: Int
            if (first <= 0x7f) {
                codePoint = first
                continuationCount = 0
            } else if ((first and 0xe0) == 0xc0) {
                codePoint = first and 0x1f
                continuationCount = 1
            } else if ((first and 0xf0) == 0xe0) {
                codePoint = first and 0x0f
                continuationCount = 2
            } else if ((first and 0xf8) == 0xf0) {
                codePoint = first and 0x07
                continuationCount = 3
            } else {
                throw IllegalArgumentException("Invalid UTF-8 channel key")
            }

            repeat(continuationCount) {
                val continuation = bytes.getOrNull(index++)
                require(continuation != null && (continuation and 0xc0) == 0x80) { "Invalid UTF-8 channel key" }
                codePoint = (codePoint shl 6) or (continuation and 0x3f)
            }

            require(
                codePoint <= 0x10ffff &&
                    codePoint !in 0xd800..0xdfff &&
                    !(continuationCount == 1 && codePoint < 0x80) &&
                    !(continuationCount == 2 && codePoint < 0x800) &&
                    !(continuationCount == 3 && codePoint < 0x10000),
            ) {
                "Invalid UTF-8 channel key"
            }
            result.appendCodePoint(codePoint)
        }
        return result.toString()
    }

    private fun base64UrlEncode(bytes: List<Int>): String {
        val result = StringBuilder()
        var index = 0
        while (index < bytes.size) {
            val first = bytes[index]
            val second = bytes.getOrNull(index + 1)
            val third = bytes.getOrNull(index + 2)
            val value = (first shl 16) or ((second ?: 0) shl 8) or (third ?: 0)

            result.append(BASE64URL_ALPHABET[(value shr 18) and 0x3f])
            result.append(BASE64URL_ALPHABET[(value shr 12) and 0x3f])
            if (second != null) result.append(BASE64URL_ALPHABET[(value shr 6) and 0x3f])
            if (third != null) result.append(BASE64URL_ALPHABET[value and 0x3f])
            index += 3
        }
        return result.toString()
    }

    private fun base64UrlDecode(value: String): List<Int> {
        require(BASE64URL_PATTERN.matches(value) && value.length % 4 != 1) { "Invalid channel key" }

        val bytes = ArrayList<Int>()
        var index = 0
        while (index < value.length) {
            val chunk = value.substring(index, minOf(index + 4, value.length))
            val encoded = chunk.map { BASE64URL_ALPHABET.indexOf(it) }
            require(encoded.all { it >= 0 }) { "Invalid channel key" }

            val bits =
                (encoded[0] shl 18) or
                    (encoded[1] shl 12) or
                    ((encoded.getOrNull(2) ?: 0) shl 6) or
                    (encoded.getOrNull(3) ?: 0)
            bytes.add((bits shr 16) and 0xff)
            if (chunk.length >= 3) bytes.add((bits shr 8) and 0xff)
            if (chunk.length == 4) bytes.add(bits and 0xff)
            index += 4
        }
        return bytes
    }
}

/** Whether JavaScript's `String.prototype.trim` removes [char]. */
internal fun isJsWhitespace(char: Char): Boolean {
    val code = char.code
    return code in 0x09..0x0d ||
        code == 0x20 ||
        code == 0xa0 ||
        code == 0x1680 ||
        code in 0x2000..0x200a ||
        code == 0x2028 ||
        code == 0x2029 ||
        code == 0x202f ||
        code == 0x205f ||
        code == 0x3000 ||
        code == 0xfeff
}

/** JavaScript's `String.prototype.trim`, whose whitespace differs from Kotlin's `trim`. */
internal fun String.trimJsWhitespace(): String = trim(::isJsWhitespace)
