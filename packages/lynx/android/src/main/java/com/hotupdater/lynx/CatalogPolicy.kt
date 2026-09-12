package com.hotupdater.lynx

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.text.Normalizer
import java.util.Collections
import java.util.Locale

/** Pure APP_VERSION policy. The controller owns the snapshot, accepted catalog and publish lock. */
internal object CatalogPolicy {
    private const val MAX_WIRE_BYTES = 256 * 1024 * 2 + 4096
    private const val MAX_SAFE_INTEGER = 9007199254740991L
    private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val catalogHash = Regex("sha256:[0-9a-f]{64}")
    private val contextHash = Regex("v1:[0-9a-f]{16}")

    class Rejected(val code: String, message: String) : IllegalArgumentException(message)

    data class Receipt(
        val kind: String,
        val releaseId: String?,
        val bundleId: String,
        val catalogId: String?,
        val scopeKey: String?,
        val generation: Long?,
        val catalogHash: String?,
        val channel: String,
        val selectionContextHash: String?,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("kind", kind).put("releaseId", releaseId ?: JSONObject.NULL)
            .put("bundleId", bundleId).put("catalogId", catalogId ?: JSONObject.NULL)
            .put("scopeKey", scopeKey ?: JSONObject.NULL).put("generation", generation ?: JSONObject.NULL)
            .put("catalogHash", catalogHash ?: JSONObject.NULL).put("channel", channel)
            .put("selectionContextHash", selectionContextHash ?: JSONObject.NULL)
    }

    class NativeSnapshot(
        val revision: String,
        val appVersion: String,
        val channel: String,
        val runtimeId: String,
        val embeddedBundleId: String,
        val minimumBundleId: String,
        val cohort: String,
        val runningSelection: Receipt,
        val nextSelection: Receipt?,
        crashedBundleIds: List<String>,
        unconfirmedReleaseIds: List<String>,
        val fingerprintHash: String? = null,
    ) {
        val crashedBundleIds: List<String> = immutable(crashedBundleIds)
        val unconfirmedReleaseIds: List<String> = immutable(unconfirmedReleaseIds)
        val base: Receipt get() = nextSelection ?: runningSelection

        init {
            ensure(revision.isNotEmpty() && runtimeId.isNotEmpty(), "INVALID_STATE", "Native identity is missing")
            ensure(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(appVersion), "INVALID_STATE", "Native appVersion must be canonical")
            ensure(appVersion.split('.').all { it.toLongOrNull()?.let { part -> part <= MAX_SAFE_INTEGER } == true }, "INVALID_STATE", "Native appVersion exceeds safe bounds")
            validateChannel(channel)
            ensure(nativeBundleId(embeddedBundleId) && nativeBundleId(minimumBundleId), "INVALID_STATE", "Invalid native bundle identity")
            ensure(validCohort(cohort), "INVALID_STATE", "Invalid native cohort")
            listOfNotNull(runningSelection, nextSelection).forEach { receipt ->
                validateReceipt(receipt)
                ensure(receipt.kind == "BUNDLE" || receipt.bundleId == embeddedBundleId, "INVALID_STATE", "Embedded receipt identity mismatch")
            }
            ensure(this.crashedBundleIds.all { uuid.matches(it) } && this.unconfirmedReleaseIds.all { uuid.matches(it) }, "INVALID_STATE", "Invalid native exclusion identity")
        }
    }

    data class HighWater(val catalogId: String, val scopeKey: String, val generation: Long, val catalogHash: String)

    data class Guard(
        val revision: String,
        val catalogId: String,
        val scopeKey: String,
        val generation: Long,
        val catalogHash: String,
        val channel: String,
        val selectionContextHash: String,
    ) {
        fun toJson(): JSONObject = JSONObject().put("revision", revision).put("catalogId", catalogId)
            .put("scopeKey", scopeKey).put("generation", generation).put("catalogHash", catalogHash)
            .put("channel", channel).put("selectionContextHash", selectionContextHash)
    }

    internal data class Descriptor(
        val releaseId: String,
        val kind: String,
        val bundleId: String?,
        val rolloutCohortCount: Int,
        val targetCohorts: List<String>,
        val shouldForceUpdate: Boolean,
        val message: String?,
    )

    class AcceptedCatalog internal constructor(
        val guard: Guard,
        val appVersion: String,
        internal val releases: List<Descriptor>,
        internal val rollbackReleases: List<Descriptor>,
    ) {
        val highWater: HighWater get() = HighWater(guard.catalogId, guard.scopeKey, guard.generation, guard.catalogHash)
    }

    data class DesiredSelection(val receipt: Receipt, val status: String)
    /** Native journal provenance, produced only after verifying a rollback transition. */
    data class RollbackAuthorization(val receipt: Receipt, val fromSelection: Receipt)
    data class AuthorizedSelection(val receipt: Receipt, val status: String, val authorizationReason: String,
        val rollbackAuthorization: RollbackAuthorization? = null)

    /** The hash is a freshness token for a projected catalog, not a signature of its HTTP body. */
    fun accept(
        catalogJson: String,
        snapshot: NativeSnapshot,
        expectedRevision: String,
        claimedContextHash: String,
        highWater: HighWater? = null,
        previouslyAcceptedCatalog: AcceptedCatalog? = null,
    ): AcceptedCatalog {
        ensure(expectedRevision == snapshot.revision, "STALE_STATE", "Native revision changed")
        val json = parseObject(catalogJson)
        ensure(integer(json, "schemaVersion", 1, 1) == 1L, "INVALID_CATALOG", "Unsupported catalog schema")
        val id = text(json, "catalogId")
        ensure(id.isNotEmpty(), "INVALID_CATALOG", "Catalog identity is empty")
        val scope = text(json, "scopeKey")
        ensure(matchesScope(scope, snapshot), "INVALID_SCOPE", "Unexpected catalog scope")
        val nativeContext = selectionContextHash(snapshot, scope)
        ensure(claimedContextHash == nativeContext, "INVALID_CONTEXT", "Selection context does not match native state")
        val generation = integer(json, "generation", 1, MAX_SAFE_INTEGER)
        val hash = text(json, "catalogHash")
        ensure(catalogHash.matches(hash), "INVALID_CATALOG", "Invalid catalog hash")
        ensure(text(json, "fallbackPolicy") == "BUILTIN_IF_ACTIVE_INELIGIBLE", "INVALID_CATALOG", "Unsupported fallback policy")
        val releases = descriptors(array(json, "releases"))
        val rollback = if (json.has("rollbackReleases")) descriptors(array(json, "rollbackReleases")) else releases
        val byId = mutableMapOf<String, Descriptor>()
        val targets = mutableSetOf<String>()
        (releases + rollback).forEach { descriptor ->
            val previous = byId.put(descriptor.releaseId, descriptor)
            ensure(previous == null || previous == descriptor, "INVALID_CATALOG", "Conflicting Release descriptors")
            targets.addAll(descriptor.targetCohorts)
        }
        ensure(targets.size <= 512, "INVALID_CATALOG", "Catalog exceeds target cohort limit")
        if (highWater != null) {
            ensure(highWater.generation in 1..MAX_SAFE_INTEGER && catalogHash.matches(highWater.catalogHash), "INVALID_STATE", "Invalid native high-water record")
            ensure(highWater.catalogId == id && highWater.scopeKey == scope, "INVALID_SCOPE", "High-water scope mismatch")
            ensure(generation >= highWater.generation, "STALE_GENERATION", "Catalog generation is stale")
            ensure(generation != highWater.generation || hash == highWater.catalogHash, "GENERATION_HASH_MISMATCH", "Catalog generation was reused with different bytes")
        }
        val base = snapshot.base
        if (base.scopeKey != null && base.generation != null) {
            ensure(base.catalogId == id && base.scopeKey == scope, "UNSOLICITED_SCOPE", "Catalog changes the native selection scope")
        }
        val previous = previouslyAcceptedCatalog
        if (previous != null && previous.appVersion == snapshot.appVersion &&
            previous.guard.catalogId == id && previous.guard.scopeKey == scope &&
            previous.guard.generation == generation && previous.guard.catalogHash == hash) {
            ensure(previous.releases == releases && previous.rollbackReleases == rollback, "CATALOG_BODY_MISMATCH", "Accepted catalog projection changed without a new generation or hash")
        }
        return AcceptedCatalog(Guard(snapshot.revision, id, scope, generation, hash, snapshot.channel, nativeContext), snapshot.appVersion, releases, rollback)
    }

    /** Re-run under the controller's final publish lock with its latest native snapshot. */
    fun verifySelection(
        accepted: AcceptedCatalog,
        snapshot: NativeSnapshot,
        guardJson: String,
        receiptJson: String,
    ): AuthorizedSelection {
        val suppliedGuard = parseGuard(parseObject(guardJson))
        ensure(suppliedGuard == accepted.guard, "STALE_SELECTION", "Guard does not match the accepted catalog")
        val desired = desiredSelection(accepted, snapshot)
            ?: throw Rejected("NO_SELECTION", "Catalog does not select an update")
        val suppliedReceipt = parseReceipt(parseObject(receiptJson))
        ensure(suppliedReceipt == desired.receipt, "INVALID_SELECTION", "Receipt is not the native policy selection")
        val reason = authorize(snapshot.base, desired.receipt)
        val rollback = if (desired.status == "ROLLBACK" && desired.receipt.kind == "BUNDLE")
            RollbackAuthorization(desired.receipt, snapshot.base) else null
        return AuthorizedSelection(desired.receipt, desired.status, reason, rollback)
    }

    fun desiredSelection(accepted: AcceptedCatalog, snapshot: NativeSnapshot): DesiredSelection? {
        val guard = accepted.guard
        ensure(guard.revision == snapshot.revision && guard.channel == snapshot.channel && matchesScope(guard.scopeKey, snapshot) && guard.selectionContextHash == selectionContextHash(snapshot, guard.scopeKey), "STALE_SELECTION", "Native selection context changed")
        val base = snapshot.base
        val excluded = snapshot.unconfirmedReleaseIds.toSet()
        val crashed = snapshot.crashedBundleIds.toSet()
        val hasActive = base.bundleId != snapshot.embeddedBundleId
        fun safe(item: Descriptor): Boolean = safeBundle(item, snapshot, excluded, crashed)
        fun selected(item: Descriptor?, kind: String, bundle: String, status: String): DesiredSelection = DesiredSelection(
            Receipt(kind, item?.releaseId, bundle, guard.catalogId, guard.scopeKey, guard.generation, guard.catalogHash, guard.channel, guard.selectionContextHash), status,
        )
        fun bundle(item: Descriptor, status: String) = selected(item, "BUNDLE", item.bundleId!!, status)

        for (item in accepted.releases) {
            if (item.releaseId in excluded || !eligible(item, snapshot.cohort)) continue
            if ((base.releaseId != null && item.releaseId <= base.releaseId) ||
                (base.releaseId == null && hasActive && (item.bundleId == null || item.bundleId <= base.bundleId))) continue
            if (safe(item)) return bundle(item, "UPDATE")
            if (item.bundleId != null) continue
            return selected(item, "EMBEDDED", snapshot.embeddedBundleId, "ROLLBACK")
        }
        if (base.releaseId != null || hasActive) {
            val current = accepted.rollbackReleases.find { it.releaseId == base.releaseId || (base.releaseId == null && it.bundleId == base.bundleId) }
            if (current != null && safe(current) && eligible(current, snapshot.cohort)) return bundle(current, "UPDATE")
            val rollback = accepted.rollbackReleases.find { safe(it) && (if (base.releaseId != null) it.releaseId < base.releaseId else it.bundleId!! < base.bundleId) }
            if (rollback != null) return bundle(rollback, "ROLLBACK")
            if (base.bundleId <= snapshot.minimumBundleId) return null
        }
        return selected(null, "BUILTIN", snapshot.embeddedBundleId, "ROLLBACK")
    }

    /** Continued eligibility of an already authorized stored receipt; this grants no new selection. */
    fun isStoredSelectionEligible(
        accepted: AcceptedCatalog,
        snapshot: NativeSnapshot,
        receipt: Receipt,
        highWater: HighWater,
        rollbackAuthorization: RollbackAuthorization? = null,
    ): Boolean {
        try { validateReceipt(receipt) } catch (_: Rejected) { return false }
        if (receipt.kind == "BUILTIN" && receipt.catalogId == null) {
            return receipt.bundleId == snapshot.embeddedBundleId
        }
        if (receipt.channel != snapshot.channel ||
            (receipt.kind != "BUNDLE" && receipt.bundleId != snapshot.embeddedBundleId)) return false
        val guard = accepted.guard
        if (accepted.highWater != highWater || accepted.appVersion != snapshot.appVersion ||
            guard.channel != snapshot.channel || !matchesScope(guard.scopeKey, snapshot) ||
            receipt.catalogId != guard.catalogId || receipt.scopeKey != guard.scopeKey) return false
        val base = snapshot.base
        if (base.generation != null && (base.catalogId != guard.catalogId || base.scopeKey != guard.scopeKey ||
            base.generation > guard.generation ||
            (base.generation == guard.generation && base.catalogHash != guard.catalogHash))) return false
        val generation = receipt.generation ?: return false
        if (generation > guard.generation ||
            (generation == guard.generation && receipt.catalogHash != guard.catalogHash)) return false
        if (receipt.kind == "BUILTIN") return true
        val item = accepted.rollbackReleases.find { it.releaseId == receipt.releaseId } ?: return false
        if (item.kind != receipt.kind || (!eligible(item, snapshot.cohort) && !authorizedRollback(receipt, rollbackAuthorization, snapshot.embeddedBundleId)) ||
            item.releaseId in snapshot.unconfirmedReleaseIds) return false
        return if (item.kind == "EMBEDDED") item.bundleId == null else
            item.bundleId == receipt.bundleId && safeBundle(item, snapshot,
                snapshot.unconfirmedReleaseIds.toSet(), snapshot.crashedBundleIds.toSet())
    }

    private fun safeBundle(item: Descriptor, snapshot: NativeSnapshot, excluded: Set<String>, crashed: Set<String>): Boolean =
        item.kind == "BUNDLE" && item.bundleId != null && item.releaseId !in excluded &&
            item.bundleId !in crashed && item.bundleId >= snapshot.minimumBundleId

    private fun authorizedRollback(receipt: Receipt, proof: RollbackAuthorization?, embeddedBundleId: String): Boolean {
        if (receipt.kind != "BUNDLE" || proof?.receipt != receipt) return false
        val from = proof.fromSelection
        try { validateReceipt(from) } catch (_: Rejected) { return false }
        if (from.catalogId != receipt.catalogId || from.scopeKey != receipt.scopeKey || from.channel != receipt.channel ||
            from.generation == null || receipt.generation == null || from.generation > receipt.generation) return false
        return if (from.releaseId != null) receipt.releaseId!! < from.releaseId else
            from.bundleId != embeddedBundleId && receipt.bundleId < from.bundleId
    }

    fun selectionContextHash(snapshot: NativeSnapshot, scopeKey: String? = null): String {
        val base = snapshot.base
        val crashed = snapshot.crashedBundleIds.distinct().sorted().take(10)
        val unconfirmed = snapshot.unconfirmedReleaseIds.distinct().sorted()
        val fingerprint = scopeKey?.startsWith("v1:fingerprint:") == true
        val strategy = if (fingerprint) "FINGERPRINT" else "APP_VERSION"
        val strategyValue = if (fingerprint) snapshot.fingerprintHash.orEmpty() else snapshot.appVersion
        // Exact property order and omission behavior of @hot-updater/core's JSON.stringify.
        val canonical = "{\"activeBundleId\":${quote(base.bundleId)},\"activeReleaseId\":${quote(base.releaseId)}," +
            "\"cohort\":${quote(normalizeCohort(snapshot.cohort))},\"crashedBundleIds\":${stringArray(crashed)}," +
            "\"minimumReleaseId\":${quote(snapshot.minimumBundleId)},\"selectorSchemaVersion\":1," +
            "\"strategy\":\"$strategy\",\"strategyValue\":${quote(strategyValue)}" +
            (if (unconfirmed.isEmpty()) "" else ",\"unconfirmedReleaseIds\":${stringArray(unconfirmed)}") + "}"
        var first = 0x811c9dc5.toInt()
        var second = 0x9e3779b9.toInt()
        canonical.forEach { character ->
            first = (first xor character.code) * 0x01000193
            second = (second xor character.code) * 0x85ebca6b.toInt()
        }
        return "v1:${first.toUInt().toString(16).padStart(8, '0')}${second.toUInt().toString(16).padStart(8, '0')}"
    }

    fun parseReceipt(json: JSONObject): Receipt {
        val receipt = Receipt(text(json, "kind"), nullableText(json, "releaseId"), text(json, "bundleId"),
            nullableText(json, "catalogId"), nullableText(json, "scopeKey"),
            if (required(json, "generation") == JSONObject.NULL) null else integer(json, "generation", 1, MAX_SAFE_INTEGER),
            nullableText(json, "catalogHash"), text(json, "channel"), nullableText(json, "selectionContextHash"))
        validateReceipt(receipt)
        return receipt
    }

    private fun validateReceipt(receipt: Receipt) {
        ensure(receipt.kind in setOf("BUNDLE", "EMBEDDED", "BUILTIN") &&
            (if (receipt.kind == "BUNDLE") uuid.matches(receipt.bundleId) else nativeBundleId(receipt.bundleId)), "INVALID_RECEIPT", "Invalid selection identity")
        ensure(if (receipt.kind == "BUILTIN") receipt.releaseId == null else receipt.releaseId?.let { uuid.matches(it) } == true, "INVALID_RECEIPT", "Invalid Release identity")
        validateChannel(receipt.channel)
        val unauthenticated = receipt.catalogId == null && receipt.scopeKey == null && receipt.generation == null && receipt.catalogHash == null && receipt.selectionContextHash == null
        if (unauthenticated) {
            ensure(receipt.kind == "BUILTIN", "INVALID_RECEIPT", "Only native embedded selection may lack catalog authority")
        } else {
            ensure(!receipt.catalogId.isNullOrEmpty() && receipt.scopeKey?.let { validScopeKey(it, receipt.channel) } == true &&
                receipt.generation != null && receipt.generation in 1..MAX_SAFE_INTEGER &&
                receipt.catalogHash?.let { catalogHash.matches(it) } == true &&
                receipt.selectionContextHash?.let { contextHash.matches(it) } == true, "INVALID_RECEIPT", "Incomplete catalog authority")
        }
    }

    private fun authorize(active: Receipt, desired: Receipt): String {
        if (active.scopeKey == null || active.generation == null) return "FIRST_AUTHENTICATED_SELECTION"
        ensure(desired.catalogId == active.catalogId && desired.scopeKey == active.scopeKey, "UNSOLICITED_SCOPE", "Unsolicited scope transition")
        val desiredGeneration = desired.generation ?: throw Rejected("STALE_GENERATION", "Missing transition generation")
        ensure(desiredGeneration >= active.generation, "STALE_GENERATION", "Stale transition generation")
        if (desiredGeneration > active.generation) return "NEWER_POLICY"
        if (desired.selectionContextHash != active.selectionContextHash) return "CONTEXT_RESELECTION"
        throw Rejected("BACKWARD_NOT_AUTHORIZED", "Selection has no newer policy or changed native context")
    }

    private fun nativeBundleId(value: String): Boolean = value == NIL_UUID || uuid.matches(value)

    private fun descriptors(values: JSONArray): List<Descriptor> {
        val result = ArrayList<Descriptor>()
        val ids = mutableSetOf<String>()
        for (index in 0 until values.length()) {
            val json = values.opt(index) as? JSONObject ?: throw Rejected("INVALID_CATALOG", "Expected Release object")
            val releaseId = text(json, "releaseId")
            ensure(uuid.matches(releaseId) && ids.add(releaseId), "INVALID_CATALOG", "Invalid or duplicate Release ID")
            ensure(result.lastOrNull()?.let { it.releaseId > releaseId } != false, "INVALID_CATALOG", "Releases must be ordered newest first")
            val kind = text(json, "kind")
            val bundleId = nullableText(json, "bundleId")
            ensure((kind == "BUNDLE" && bundleId?.let { uuid.matches(it) } == true) || (kind == "EMBEDDED" && bundleId == null), "INVALID_CATALOG", "Invalid Release bundle identity")
            val cohorts = array(json, "targetCohorts")
            ensure(cohorts.length() <= 100, "INVALID_CATALOG", "Too many target cohorts")
            val targets = (0 until cohorts.length()).map { offset ->
                val target = cohorts.opt(offset) as? String ?: throw Rejected("INVALID_CATALOG", "Invalid target cohort")
                ensure(validCohort(target), "INVALID_CATALOG", "Invalid target cohort")
                target
            }
            val force = required(json, "shouldForceUpdate") as? Boolean ?: throw Rejected("INVALID_CATALOG", "Expected boolean force-update flag")
            result.add(Descriptor(releaseId, kind, bundleId, integer(json, "rolloutCohortCount", 0, 1000).toInt(), immutable(targets), force, nullableText(json, "message")))
        }
        return immutable(result)
    }

    private fun eligible(item: Descriptor, rawCohort: String): Boolean {
        val cohort = normalizeCohort(rawCohort)
        if (item.targetCohorts.any { normalizeCohort(it) == cohort }) return true
        if (item.rolloutCohortCount == 0) return false
        val numeric = numericCohort(cohort)
        if (numeric == null) return item.rolloutCohortCount == 1000 && validCohort(cohort)
        if (item.rolloutCohortCount == 1000) return true
        var multiplier = positiveMod(javaScriptHash("${item.releaseId}:multiplier"), 997).let { if (it == 0) 1 else it }
        while (gcd(multiplier, 1000) != 1) multiplier = positiveMod(multiplier + 1, 1000).let { if (it == 0) 1 else it }
        val inverse = (1 until 1000).first { (it * multiplier) % 1000 == 1 }
        val offset = positiveMod(javaScriptHash("${item.releaseId}:offset"), 1000)
        return positiveMod(inverse * (numeric - 1 - offset), 1000) < item.rolloutCohortCount
    }

    private fun normalizeCohort(value: String): String {
        val normalized = jsTrim(value).lowercase(Locale.ROOT)
        return numericCohort(normalized)?.toString() ?: normalized
    }

    private fun numericCohort(value: String): Int? = if (Regex("[0-9]+").matches(value)) value.toIntOrNull()?.takeIf { it in 1..1000 } else null
    private fun validCohort(value: String): Boolean {
        val normalized = normalizeCohort(value)
        return numericCohort(normalized) != null || (normalized.length in 1..64 && Regex("[a-z0-9-]+").matches(normalized) && !Regex("[0-9]+").matches(normalized))
    }
    private fun javaScriptHash(value: String): Int = value.fold(0) { hash, character -> hash * 31 + character.code }
    private fun positiveMod(value: Int, modulus: Int): Int = ((value % modulus) + modulus) % modulus
    private fun gcd(first: Int, second: Int): Int { var a = first; var b = second; while (b != 0) { val next = a % b; a = b; b = next }; return a }

    fun channelKey(channel: String): String { validateChannel(channel); return base64Url(channel.toByteArray(Charsets.UTF_8)) }
    private fun expectedScope(channel: String): String = "v1:app-version:android:${channelKey(channel)}"
    private fun fingerprintScope(channel: String, hash: String): String =
        "v1:fingerprint:android:${channelKey(channel)}:$hash"
    private fun matchesScope(scope: String, snapshot: NativeSnapshot): Boolean {
        if (scope == expectedScope(snapshot.channel)) return true
        val hash = snapshot.fingerprintHash
        return !hash.isNullOrEmpty() && scope == fingerprintScope(snapshot.channel, hash)
    }
    private fun validScopeKey(scope: String, channel: String): Boolean {
        if (scope == expectedScope(channel)) return true
        val prefix = "v1:fingerprint:android:${channelKey(channel)}:"
        val rest = scope.removePrefix(prefix)
        return scope.startsWith(prefix) && rest.isNotEmpty() && ':' !in rest
    }
    private fun validateChannel(channel: String) {
        ensure(channel.isNotEmpty() && channel == jsTrim(channel) && channel == Normalizer.normalize(channel, Normalizer.Form.NFC) && channel.codePointCount(0, channel.length) <= 255, "INVALID_STATE", "Invalid native channel")
    }
    private fun jsTrim(value: String): String = value.trim {
        it in '\u0009'..'\u000d' || it in '\u2000'..'\u200a' ||
            it in charArrayOf('\u0020', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff')
    }
    private fun base64Url(bytes: ByteArray): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        return buildString {
            var index = 0
            while (index < bytes.size) {
                val remaining = bytes.size - index
                val value = ((bytes[index].toInt() and 255) shl 16) or
                    (if (remaining > 1) (bytes[index + 1].toInt() and 255) shl 8 else 0) or
                    (if (remaining > 2) bytes[index + 2].toInt() and 255 else 0)
                append(alphabet[(value shr 18) and 63]); append(alphabet[(value shr 12) and 63])
                if (remaining > 1) append(alphabet[(value shr 6) and 63])
                if (remaining > 2) append(alphabet[value and 63])
                index += 3
            }
        }
    }

    private fun parseGuard(json: JSONObject): Guard = Guard(text(json, "revision"), text(json, "catalogId"), text(json, "scopeKey"), integer(json, "generation", 1, MAX_SAFE_INTEGER), text(json, "catalogHash"), text(json, "channel"), text(json, "selectionContextHash"))
    private fun parseObject(value: String): JSONObject {
        ensure(value.toByteArray(Charsets.UTF_8).size <= MAX_WIRE_BYTES, "INVALID_CATALOG", "JSON exceeds catalog size limit")
        try {
            val tokener = JSONTokener(value)
            val parsed = tokener.nextValue() as? JSONObject ?: throw Rejected("INVALID_CATALOG", "Expected JSON object")
            ensure(tokener.nextClean() == '\u0000', "INVALID_CATALOG", "Trailing JSON content")
            return parsed
        } catch (error: Rejected) { throw error } catch (error: Exception) {
            throw Rejected("INVALID_CATALOG", "Malformed JSON")
        }
    }
    private fun required(json: JSONObject, key: String): Any {
        ensure(json.has(key), "INVALID_CATALOG", "Missing $key")
        return json.get(key)
    }
    private fun text(json: JSONObject, key: String): String = required(json, key) as? String ?: throw Rejected("INVALID_CATALOG", "Expected string $key")
    private fun nullableText(json: JSONObject, key: String): String? {
        if (!json.has(key)) return null
        return when (val value = json.get(key)) {
            JSONObject.NULL -> null
            is String -> value
            else -> throw Rejected(
                "INVALID_CATALOG",
                "Expected nullable string $key",
            )
        }
    }
    private fun array(json: JSONObject, key: String): JSONArray = required(json, key) as? JSONArray ?: throw Rejected("INVALID_CATALOG", "Expected array $key")
    private fun integer(json: JSONObject, key: String, minimum: Long, maximum: Long): Long {
        val number = required(json, key) as? Number ?: throw Rejected("INVALID_CATALOG", "Expected integer $key")
        val value = number.toDouble()
        ensure(value.isFinite() && value >= minimum.toDouble() && value <= maximum.toDouble() && value == kotlin.math.floor(value), "INVALID_CATALOG", "Unsafe integer $key")
        return value.toLong()
    }
    private fun quote(value: String?): String = if (value == null) "null" else JSONObject.quote(value)
    private fun stringArray(values: List<String>): String = values.joinToString(",", "[", "]") { quote(it) }
    private fun <T> immutable(values: List<T>): List<T> = Collections.unmodifiableList(ArrayList(values))
    private fun ensure(condition: Boolean, code: String, message: String) { if (!condition) throw Rejected(code, message) }
}
