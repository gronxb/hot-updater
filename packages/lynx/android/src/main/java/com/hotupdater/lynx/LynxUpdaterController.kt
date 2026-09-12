package com.hotupdater.lynx

import android.content.Context
import android.util.Log
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.HashUtils
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

/** Native policy, scoped persistence and immutable process selection. */
class LynxUpdaterController internal constructor(
    filesDir: File,
    packageCodePath: File,
    private val embedded: VerifiedLynxInstallation,
    val configuration: LynxHostConfiguration,
) {
    constructor(context: Context, configuration: LynxHostConfiguration) : this(
        context.filesDir,
        File(context.packageCodePath),
        loadEmbedded(context, configuration),
        configuration,
    )
    private val stateLock = Any()
    private val binaryId = HashUtils.calculateSHA256(packageCodePath)
    private val keyIdentity = ArchiveIntegrity(configuration.publicKeyPem).keyIdentity
    private val namespace = digestString(listOf(binaryId, configuration.runtimeId, configuration.channel,
        configuration.appVersion, embedded.bundleId, embedded.manifestHash, keyIdentity).joinToString("\n"))
    private val directory = File(filesDir, "hot-updater-lynx/scopes/$namespace").canonicalFile
    private val store = LynxStateStore(directory)
    private val installer = LynxArtifactInstaller(File(directory, "artifacts"), LynxInstallConfiguration(configuration.runtimeId, configuration.publicKeyPem))
    private var running = builtin()
    private var runningFiles = embedded
    private var runningConfirmed = false
    private var primary: LynxLaunchSession? = null
    private var accepted: CatalogPolicy.AcceptedCatalog? = null
    private data class Preparation(val guard: String, val receipt: CatalogPolicy.Receipt,
        val artifact: LynxArtifactRequest?, val bytes: PreparedLynxArtifact?, val contextId: String)
    private val preparations = mutableMapOf<String, Preparation>()
    private val preparing = mutableMapOf<String, String>()

    init {
        synchronized(stateLock) {
            if (!store.value.has("revision")) store.update { it.put("revision", UUID.randomUUID().toString()) }
            recover()
            running = receipt("active") ?: builtin()
            // The process does not execute any restored candidate before pinPrimary().
        }
        Log.i(TAG, "native-profile binary=$binaryId runtime=${configuration.runtimeId} scope=$namespace")
    }

    private fun builtin() = CatalogPolicy.Receipt("BUILTIN", null, embedded.bundleId, null, null, null, null, configuration.channel, null)
    private fun receipt(key: String) = store.value.optJSONObject(key)?.let(CatalogPolicy::parseReceipt)
    private fun exclusions(key: String): List<String> = store.value.optJSONArray(key)?.let { array -> (0 until array.length()).map { array.getString(it) } } ?: emptyList()
    private fun eligible(value: CatalogPolicy.Receipt) = value.releaseId !in exclusions("unconfirmed") &&
        (value.bundleId == embedded.bundleId || value.bundleId !in exclusions("crashed"))
    private var runtimeCohort: String = configuration.cohort
    private var runtimeChannel: String = configuration.channel
    private fun snapshot() = CatalogPolicy.NativeSnapshot(store.value.getString("revision"), configuration.appVersion,
        runtimeChannel, configuration.runtimeId, embedded.bundleId, embedded.bundleId, runtimeCohort,
        running, receipt("next"), exclusions("crashed"), exclusions("unconfirmed"))
    private fun mutate(change: (JSONObject) -> Unit) = store.update { change(it); it.put("revision", UUID.randomUUID().toString()) }
    private fun highWater(): CatalogPolicy.HighWater? = store.value.optJSONObject("highWater")?.let {
        CatalogPolicy.HighWater(it.getString("catalogId"), it.getString("scopeKey"), it.getLong("generation"), it.getString("catalogHash"))
    }
    private fun recover() {
        val pending = store.value.optJSONObject("pending") ?: return
        val selected = CatalogPolicy.parseReceipt(pending.getJSONObject("selection"))
        mutate { next ->
            if (selected.releaseId != null) {
                val key = if (pending.optBoolean("fatal") && selected.bundleId != embedded.bundleId) "crashed" else "unconfirmed"
                val id = if (key == "crashed") selected.bundleId else checkNotNull(selected.releaseId)
                val values = exclusions(key).toMutableSet().also { it.add(id) }
                next.put(key, JSONArray(values.toList()))
            }
            next.remove("pending")
        }
        Log.i(TAG, "recovered release=${selected.releaseId} fatal=${pending.optBoolean("fatal")}")
    }
    private fun artifact(value: JSONObject) = LynxArtifactRequest(value.getString("bundleId"), value.getString("fileUrl"), value.getString("fileHash"), value.opt("manifestFileHash").let { if (it == null || it == JSONObject.NULL) null else it as String })
    private fun artifactJson(value: LynxArtifactRequest) = JSONObject().put("bundleId", value.bundleId).put("fileUrl", value.fileUrl).put("fileHash", value.fileHash).put("manifestFileHash", value.manifestFileHash ?: JSONObject.NULL)
    private fun installed(value: CatalogPolicy.Receipt): VerifiedLynxInstallation {
        if (value.bundleId == embedded.bundleId) return embedded
        val record = checkNotNull(store.value.optJSONObject("artifacts")?.optJSONObject(value.bundleId)) { "No verified artifact receipt" }
        val request = artifact(record)
        val root = File(directory, "artifacts/installations/${value.bundleId}")
        val integrity = ArchiveIntegrity(configuration.publicKeyPem)
        integrity.verify(File(root, "archive"), request.fileHash)
        return LynxArtifactVerifier(LynxInstallConfiguration(configuration.runtimeId, configuration.publicKeyPem), integrity).verify(File(root, "payload"), request).also {
            check(it.manifestHash == record.getString("verifiedManifestHash")) { "Installed manifest differs from the verified archive" }
        }
    }

    /** Call before creating/evaluating the designated primary Lynx view. */
    fun pinPrimary(): LynxLaunchSession = synchronized(stateLock) {
        check(primary == null) { "The primary is already pinned; restart is required" }
        val startupSnapshot = snapshot()
        val persistedCatalog = store.value.optString("catalog").takeIf { it.isNotEmpty() }?.let {
            CatalogPolicy.accept(it, startupSnapshot, startupSnapshot.revision, CatalogPolicy.selectionContextHash(startupSnapshot), highWater())
        }
        fun eligibleStored(candidate: CatalogPolicy.Receipt): Boolean {
            if (!eligible(candidate)) return false
            if (candidate.kind == "BUILTIN" && candidate.catalogId == null) return true
            val catalog = persistedCatalog ?: return false
            val mark = highWater() ?: return false
            val proof = store.value.optJSONObject("rollbackProofs")?.optJSONObject(receiptKey(candidate))?.let {
                CatalogPolicy.RollbackAuthorization(CatalogPolicy.parseReceipt(it.getJSONObject("receipt")), CatalogPolicy.parseReceipt(it.getJSONObject("fromSelection")))
            }
            return CatalogPolicy.isStoredSelectionEligible(catalog, startupSnapshot, candidate, mark, proof)
        }
        val confirmed = receipt("confirmed")?.takeIf(::eligibleStored)
        val atCapacity = exclusions("unconfirmed").size >= CAPACITY || exclusions("crashed").size >= CAPACITY
        val candidates = listOfNotNull(receipt("next"), receipt("active"), confirmed, builtin()).distinct()
        var chosen = builtin()
        var files = embedded
        for (candidate in candidates) {
            if (!eligibleStored(candidate) || (atCapacity && candidate != confirmed && candidate.kind != "BUILTIN")) continue
            val verified = runCatching { installed(candidate) }.getOrNull() ?: continue
            chosen = candidate; files = verified; break
        }
        running = chosen; runningFiles = files; runningConfirmed = chosen == confirmed
        val session = LynxLaunchSession(this, files, UUID.randomUUID().toString(), true)
        mutate { next ->
            check(!next.has("pending")) { "Existing startup attempt cannot be replaced" }
            next.put("active", chosen.toJson()); next.remove("next")
            if (!runningConfirmed) next.put("pending", JSONObject().put("attemptId", session.id).put("selection", chosen.toJson()).put("fatal", false))
        }
        primary = session
        Log.i(TAG, "attempt-before-evaluation bundle=${chosen.bundleId} release=${chosen.releaseId} confirmed=$runningConfirmed attempt=${session.id}")
        session
    }

    fun pinSecondary(): LynxLaunchSession = synchronized(stateLock) {
        check(primary != null) { "Secondary context must wait for primary selection" }
        LynxLaunchSession(this, runningFiles, UUID.randomUUID().toString(), false)
    }

    fun setCohort(cohort: String) = synchronized(stateLock) { runtimeCohort = cohort }
    fun setChannel(channel: String) = synchronized(stateLock) { runtimeChannel = channel }
    fun resetChannel(): Boolean = synchronized(stateLock) {
        runtimeChannel = configuration.channel
        true
    }
    fun clearCrashHistory() = synchronized(stateLock) {
        mutate { it.put("crashed", JSONArray()) }
    }

    internal fun isUnconfirmedBundleTrial(): Boolean = synchronized(stateLock) {
        !runningConfirmed && running.kind == "BUNDLE"
    }

    internal fun state(session: LynxLaunchSession): JSONObject = synchronized(stateLock) {
        requireLive(session, false)
        val state = snapshot()
        JSONObject().put("revision", state.revision).put("platform", "android").put("appVersion", state.appVersion)
            .put("channel", state.channel).put("channelKey", CatalogPolicy.channelKey(state.channel)).put("runtimeId", state.runtimeId).put("embeddedBundleId", state.embeddedBundleId)
            .put("minimumBundleId", state.minimumBundleId).put("cohort", state.cohort)
            .put("runningSelection", running.toJson()).put("runningConfirmed", runningConfirmed)
            .put("confirmedSelection", receipt("confirmed")?.toJson() ?: JSONObject.NULL)
            .put("nextSelection", receipt("next")?.toJson() ?: JSONObject.NULL)
            .put("crashedBundleIds", JSONArray(state.crashedBundleIds)).put("unconfirmedReleaseIds", JSONArray(state.unconfirmedReleaseIds))
            .put("fingerprintHash", binaryId)
    }

    internal fun accept(session: LynxLaunchSession, params: JSONObject): JSONObject = synchronized(stateLock) {
        requireLive(session)
        val raw = params.getJSONObject("catalog").toString()
        val before = snapshot()
        // Persisted raw projection also binds same generation/hash bodies after restart.
        val previous = accepted ?: store.value.optString("catalog").takeIf { it.isNotEmpty() }?.let {
            CatalogPolicy.accept(it, before, before.revision, CatalogPolicy.selectionContextHash(before), highWater())
        }
        val checked = CatalogPolicy.accept(raw, before, params.getString("expectedRevision"), params.getString("selectionContextHash"), highWater(), previous)
        mutate { next -> next.put("catalog", raw); next.put("highWater", JSONObject().put("catalogId", checked.guard.catalogId)
            .put("scopeKey", checked.guard.scopeKey).put("generation", checked.guard.generation).put("catalogHash", checked.guard.catalogHash)) }
        val after = snapshot()
        accepted = CatalogPolicy.accept(raw, after, after.revision, CatalogPolicy.selectionContextHash(after), highWater(), checked)
        checkNotNull(accepted).guard.toJson()
    }

    internal suspend fun prepare(session: LynxLaunchSession, params: JSONObject): JSONObject {
        val guard = params.getJSONObject("guard").toString()
        val selected = CatalogPolicy.parseReceipt(params.getJSONObject("selection"))
        val request = params.optJSONObject("artifact")?.let(::artifact)
        val cacheKey = request?.let { digestString("${it.bundleId}\n${it.fileHash}\n${it.manifestFileHash}") }
        val reservation = UUID.randomUUID().toString()
        synchronized(stateLock) {
            authorize(session, guard, selected)
            check(preparations.size + preparing.size < 16) { "Too many outstanding preparations" }
            if (cacheKey != null && store.value.optJSONObject("incompatible")?.has(cacheKey) == true) throw LynxIncompatibleArtifactException("Cached native incompatibility")
            if (selected.kind == "BUNDLE" && !(runningConfirmed && selected.bundleId == running.bundleId)) require(request?.bundleId == selected.bundleId) { "Selection requires its archive receipt" }
            if (request != null) require(request.bundleId == selected.bundleId) { "Archive Bundle does not match selection" }
            preparing[reservation] = selected.bundleId
        }
        Log.i(TAG, "prepare-selection bundle=${selected.bundleId} release=${selected.releaseId} archive=${request != null}")
        var bytes: PreparedLynxArtifact? = null
        try {
            if (request != null) bytes = installer.prepare(request)
            coroutineContext.ensureActive()
            synchronized(stateLock) {
                authorize(session, guard, selected)
                val id = UUID.randomUUID().toString()
                Log.i(TAG, "verified-preparation bundle=${selected.bundleId} release=${selected.releaseId}")
                preparing.remove(reservation)
                preparations[id] = Preparation(guard, selected, request, bytes, session.id)
                return JSONObject().put("preparedId", id)
            }
        } catch (error: Throwable) {
            bytes?.let(installer::discard)
            if (error is LynxIncompatibleArtifactException && cacheKey != null) synchronized(stateLock) {
                store.update { next ->
                    val cache = next.optJSONObject("incompatible") ?: JSONObject()
                    if (cache.length() >= CAPACITY) cache.keys().asSequence().minByOrNull { cache.getLong(it) }?.let(cache::remove)
                    cache.put(cacheKey, System.currentTimeMillis()); next.put("incompatible", cache)
                }
            }
            throw error
        } finally { synchronized(stateLock) { preparing.remove(reservation) } }
    }

    internal suspend fun stage(session: LynxLaunchSession, id: String): JSONObject {
        val prepared = synchronized(stateLock) {
            requireLive(session)
            checkNotNull(preparations[id]?.takeIf { it.contextId == session.id }) { "Unknown prepared selection" }
        }
        var result: JSONObject? = null
        fun publishSelection(authorization: CatalogPolicy.AuthorizedSelection, verified: VerifiedLynxInstallation? = null) {
            val selected = prepared.receipt
            val adoption = runningConfirmed && selected.bundleId == running.bundleId && selected.kind == "BUNDLE"
            mutate { next ->
                authorization.rollbackAuthorization?.let { proof ->
                    val proofs = next.optJSONObject("rollbackProofs") ?: JSONObject()
                    proofs.put(receiptKey(selected), JSONObject().put("receipt", proof.receipt.toJson()).put("fromSelection", proof.fromSelection.toJson()))
                    next.put("rollbackProofs", proofs)
                }
                prepared.artifact?.let { input ->
                    val records = next.optJSONObject("artifacts") ?: JSONObject()
                    records.put(input.bundleId, artifactJson(input).put("verifiedManifestHash", checkNotNull(verified).manifestHash)); next.put("artifacts", records)
                }
                if (adoption) { next.put("active", selected.toJson()); next.put("confirmed", selected.toJson()); next.remove("next") }
                else next.put("next", selected.toJson())
            }
            if (adoption) running = selected
            result = JSONObject().put("status", if (adoption) "ADOPTED" else "STAGED").put("requiresRestart", !adoption)
            Log.i(TAG, "selection-${if (adoption) "adopted" else "staged"} bundle=${selected.bundleId} release=${selected.releaseId} running=${running.bundleId}")
        }
        try {
            if (prepared.bytes != null) installer.commitPrepared(prepared.bytes) { publish ->
                synchronized(stateLock) { val authorization = authorize(session, prepared.guard, prepared.receipt); publish().also { publishSelection(authorization, it) } }
            } else synchronized(stateLock) { val authorization = authorize(session, prepared.guard, prepared.receipt); publishSelection(authorization) }
            pruneUnused()
            return checkNotNull(result)
        } finally { synchronized(stateLock) { preparations.remove(id) } }
    }

    private fun receiptKey(receipt: CatalogPolicy.Receipt) = digestString(receipt.toJson().toString())
    private fun authorize(session: LynxLaunchSession, guard: String, selected: CatalogPolicy.Receipt): CatalogPolicy.AuthorizedSelection {
        requireLive(session)
        return CatalogPolicy.verifySelection(checkNotNull(accepted) { "No accepted native catalog" }, snapshot(), guard, selected.toJson().toString())
    }
    private fun requireLive(session: LynxLaunchSession, primaryOnly: Boolean = true) {
        if (!session.live || session.controller !== this || (primaryOnly && session !== primary)) throw CatalogPolicy.Rejected("STALE_CONTEXT", "The calling native context is not eligible")
    }
    internal fun confirm(session: LynxLaunchSession): String = synchronized(stateLock) {
        requireLive(session)
        check(session.firstScreen && !session.failed) { "Primary content is not ready" }
        if (runningConfirmed) return "ALREADY_CONFIRMED"
        val pending = store.value.optJSONObject("pending")
        check(pending?.optString("attemptId") == session.id && !pending.optBoolean("fatal")) { "Startup attempt cannot be confirmed" }
        check(eligible(running)) { "Running selection is excluded" }
        mutate { it.remove("pending"); it.put("confirmed", running.toJson()) }
        runningConfirmed = true
        Log.i(TAG, "confirmed bundle=${running.bundleId} release=${running.releaseId} attempt=${session.id}")
        "CONFIRMED"
    }
    internal fun fail(session: LynxLaunchSession, message: String) {
        session.failed = true
        synchronized(stateLock) {
        if (session !== primary || !session.live || runningConfirmed) return@synchronized
        session.failed = true
        val pending = store.value.optJSONObject("pending") ?: return@synchronized
        if (pending.optString("attemptId") != session.id) return@synchronized
        mutate { next ->
            next.put("pending", JSONObject(pending.toString()).put("fatal", true).put("message", message))
            if (running.kind == "BUNDLE") {
                val crashed = exclusions("crashed").toMutableList()
                crashed.removeAll { it == running.bundleId }
                crashed.add(running.bundleId)
                while (crashed.size > 10) crashed.removeAt(0)
                next.put("crashed", JSONArray(crashed))
            } else if (running.releaseId != null) {
                val unconfirmed = exclusions("unconfirmed").toMutableList()
                if (running.releaseId !in unconfirmed) unconfirmed.add(running.releaseId!!)
                next.put("unconfirmed", JSONArray(unconfirmed))
            }
        }
    }
        if (running.kind == "BUNDLE") {
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }
    internal fun destroy(session: LynxLaunchSession) {
        val discarded = synchronized(stateLock) {
            session.live = false
            val ids = preparations.filterValues { it.contextId == session.id }.keys.toList()
            ids.mapNotNull { preparations.remove(it)?.bytes }
        }
        discarded.forEach(installer::discard)
        pruneUnused()
    }
    private fun pruneUnused() {
        runCatching { installer.prune { removeUnused -> synchronized(stateLock) {
            val receipts = listOfNotNull(running, receipt("active"), receipt("confirmed"), receipt("next")) + preparations.values.map { it.receipt }
            // runningFiles remains protected for the whole process, including asynchronous
            // image work dispatched before a context closes. Every secondary shares it.
            val retained = receipts.map { it.bundleId }.toSet() + preparing.values + runningFiles.bundleId
            val existing = removeUnused(retained)
            val proofKeys = receipts.map(::receiptKey).toSet()
            store.update { next ->
                next.optJSONObject("artifacts")?.let { records -> records.keys().asSequence().toList().filter { it !in existing }.forEach(records::remove) }
                next.optJSONObject("rollbackProofs")?.let { proofs -> proofs.keys().asSequence().toList().filter { it !in proofKeys }.forEach(proofs::remove) }
            }
        } } }.onFailure { Log.e(TAG, "Unused cache cleanup deferred", it) }
    }
    fun close() { store.close() }
    companion object { private const val TAG = "HotUpdaterLynx"; private const val CAPACITY = 128 }
}
