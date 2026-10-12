package com.hotupdater.lynx

import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import java.io.File
import java.util.UUID
import org.json.JSONObject

internal fun retainEmbeddedFailure(previous: CatalogPolicy.Receipt?, incoming: CatalogPolicy.Receipt): CatalogPolicy.Receipt =
    previous?.takeIf { it.releaseId == null } ?: incoming

/** Reads committed native state without running foreground recovery or publishing changes. */
internal class LynxStoredSelectionReader(
    private val state: JSONObject,
    private val directory: File,
    private val embedded: VerifiedLynxInstallation,
    private val configuration: LynxHostConfiguration,
    private val binaryId: String,
) {
    private fun catalogKey(catalogId: String, scopeKey: String) = digestString("$catalogId\u0000$scopeKey")
    private fun receiptKey(receipt: CatalogPolicy.Receipt) = digestString(receipt.toJson().toString())
    private fun sameRelease(a: CatalogPolicy.Receipt, b: CatalogPolicy.Receipt) =
        a.releaseId == b.releaseId && a.bundleId == b.bundleId

    fun receipt(key: String) = state.optJSONObject(key)?.let(CatalogPolicy::parseReceipt)
    fun exclusions(key: String): List<String> = state.optJSONArray(key)?.let { array ->
        (0 until array.length()).map { array.getString(it) }
    } ?: emptyList()
    private fun interruptions() = if (state.has("interruptedReleases")) {
        state.getJSONObject("interruptedReleases")
    } else JSONObject()

    fun validateRetryRecords() {
        val records = interruptions()
        val permanent = exclusions("unconfirmed")
        check((permanent.toSet() + records.keys().asSequence().toSet()).size <= RECOVERY_CAPACITY) {
            "Startup recovery capacity exhausted"
        }
        records.keys().forEach { releaseId ->
            val record = records.getJSONObject(releaseId)
            check(UUID.fromString(releaseId).toString() == releaseId &&
                UUID.fromString(record.getString("bundleId")).toString() == record.getString("bundleId") &&
                UUID.fromString(record.getString("holdProcessToken")).toString() == record.getString("holdProcessToken") &&
                releaseId !in permanent) { "Invalid interrupted launch identity" }
            check(record.opt("retryReady") is Boolean) { "Invalid interrupted launch readiness" }
        }
    }

    /** Selection only: no trial, recovery, channel change, or readiness publication. */
    fun backgroundSelection(processToken: String, cold: Boolean): Pair<CatalogPolicy.Receipt, VerifiedLynxInstallation> {
        validateRetryRecords()
        val builtin = CatalogPolicy.Receipt("BUILTIN", null, embedded.bundleId, null, null, null, null, configuration.channel, null)
        val crashed = exclusions("crashed").toMutableSet()
        val unconfirmed = exclusions("unconfirmed").toMutableSet()
        val records = interruptions()
        records.keys().forEach { releaseId ->
            val record = records.getJSONObject(releaseId)
            if (!record.getBoolean("retryReady") || record.getString("holdProcessToken") == processToken) {
                unconfirmed.add(releaseId)
            }
        }
        var failedEmbedded = receipt("failedEmbedded")
        if (cold) {
            val pending = state.optJSONObject("pending")
            val page = state.optJSONObject("pageAttempt")
            val failure = state.optJSONObject("generationFailure")
            val interrupted = (page ?: pending ?: failure)?.getJSONObject("selection")?.let(CatalogPolicy::parseReceipt)
            if (interrupted != null) {
                val transition = pending?.opt("transitionId") as? String
                val managed = state.optJSONObject("managedTransition")?.optString("transitionId")
                val benign = pending != null && page == null && failure == null &&
                    !pending.optBoolean("fatal") && transition != null && transition == managed &&
                    runCatching { UUID.fromString(transition).toString() == transition }.getOrDefault(false) &&
                    sameRelease(interrupted, receipt("confirmed") ?: builtin)
                if (!benign) {
                    interrupted.releaseId?.let(unconfirmed::add)
                    if (page?.optBoolean("fatal") == true || pending?.optBoolean("fatal") == true || failure?.optBoolean("fatal") == true) {
                        if (interrupted.bundleId != embedded.bundleId) crashed.add(interrupted.bundleId)
                    }
                    if (interrupted.bundleId == embedded.bundleId && (page != null || failure != null)) {
                        failedEmbedded = retainEmbeddedFailure(failedEmbedded, interrupted)
                    }
                }
            }
        }
        for (candidate in listOfNotNull(receipt("next"), receipt("confirmed"), builtin).distinct()) {
            if (!eligible(candidate, crashed.toList(), unconfirmed.toList(), failedEmbedded)) continue
            val files = runCatching { installed(candidate) }.getOrNull() ?: continue
            return candidate to files
        }
        error("No eligible Lynx background selection")
    }
    private fun parseHighWater(value: JSONObject) = CatalogPolicy.HighWater(
        value.getString("catalogId"), value.getString("scopeKey"),
        value.getLong("generation"), value.getString("catalogHash"),
    )
    fun highWater(catalogId: String? = null, scopeKey: String? = null): CatalogPolicy.HighWater? {
        if (!catalogId.isNullOrEmpty() && !scopeKey.isNullOrEmpty()) {
            state.optJSONObject("highWaters")?.optJSONObject(catalogKey(catalogId, scopeKey))
                ?.let { return parseHighWater(it) }
        }
        val single = state.optJSONObject("highWater") ?: return null
        if (
            catalogId.isNullOrEmpty() ||
            scopeKey.isNullOrEmpty() ||
            (single.optString("catalogId") == catalogId && single.optString("scopeKey") == scopeKey)
        ) {
            return parseHighWater(single)
        }
        return null
    }

    fun eligible(
        candidate: CatalogPolicy.Receipt,
        crashed: List<String>,
        unconfirmed: List<String>,
        failedEmbedded: CatalogPolicy.Receipt?,
    ): Boolean {
        if (
            candidate.releaseId in unconfirmed ||
            candidate.bundleId in crashed ||
            failedEmbedded != null && sameRelease(candidate, failedEmbedded)
        ) {
            return false
        }
        if (candidate.kind == "BUILTIN" && candidate.catalogId == null) {
            return candidate.bundleId == embedded.bundleId
        }
        val catalogId = candidate.catalogId ?: return false
        val scope = candidate.scopeKey ?: return false
        val key = catalogKey(catalogId, scope)
        val raw = state.optJSONObject("catalogs")?.optString(key)
            ?.takeIf(String::isNotEmpty)
            ?: state.optString("catalog").takeIf { value ->
                if (value.isEmpty()) return@takeIf false
                val stored = JSONObject(value)
                stored.optString("catalogId") == catalogId &&
                    stored.optString("scopeKey") == scope
            }
            ?: return false
        val candidateSnapshot = CatalogPolicy.NativeSnapshot(
            state.getString("revision"),
            configuration.appVersion,
            candidate.channel,
            configuration.runtimeId,
            embedded.bundleId,
            configuration.minimumBundleId,
            state.optString("cohort").ifEmpty { configuration.cohort },
            candidate,
            null,
            crashed,
            unconfirmed,
            configuration.fingerprintHash ?: binaryId,
        )
        val catalog = runCatching {
            CatalogPolicy.accept(
                raw,
                candidateSnapshot,
                candidateSnapshot.revision,
                CatalogPolicy.selectionContextHash(candidateSnapshot, scope),
                highWater(catalogId, scope),
            )
        }.getOrNull() ?: return false
        val mark = highWater(catalog.guard.catalogId, catalog.guard.scopeKey)
            ?: return false
        val proof = state.optJSONObject("rollbackProofs")
            ?.optJSONObject(receiptKey(candidate))?.let {
                CatalogPolicy.RollbackAuthorization(
                    CatalogPolicy.parseReceipt(it.getJSONObject("receipt")),
                    CatalogPolicy.parseReceipt(
                        it.getJSONObject("fromSelection"),
                    ),
                )
            }
        return CatalogPolicy.isStoredSelectionEligible(
            catalog,
            candidateSnapshot,
            candidate,
            mark,
            proof,
        )
    }

    fun installed(value: CatalogPolicy.Receipt): VerifiedLynxInstallation {
        if (value.bundleId == embedded.bundleId) return embedded
        val record = checkNotNull(state.optJSONObject("artifacts")?.optJSONObject(value.bundleId)) { "No verified artifact receipt" }
        val root = File(directory, "artifacts/installations/${value.bundleId}")
        val integrity = ArchiveIntegrity(configuration.publicKeyPem)
        val manifestToken = record.opt("manifestFileHash").let {
            if (it == null || it == JSONObject.NULL) null else it as? String
                ?: error("Invalid installed manifest token")
        }
        val manifestBacked = true
        require(!manifestToken.isNullOrBlank()) { "Installed artifact lost its manifest trust token" }
        val request = LynxArtifactRequest(value.bundleId, manifestFileHash = manifestToken)
        return LynxArtifactVerifier(
            LynxInstallConfiguration(configuration.runtimeId, configuration.publicKeyPem),
            integrity,
        ).verify(File(root, "payload"), request, manifestBacked).also {
            check(it.manifestHash == record.getString("verifiedManifestHash")) { "Installed manifest differs from the verified archive" }
        }
    }

    companion object {
        const val RECOVERY_CAPACITY = 128
    }

}
