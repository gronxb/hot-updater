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

data class LynxLaunchDiagnostics(
    val contextId: String,
    val startupAttemptId: String,
    val bundleId: String,
    val releaseId: String?,
)

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
    private var closed = false
    private var primary: LynxLaunchSession? = null
    private var accepted: CatalogPolicy.AcceptedCatalog? = null
    private var acceptedScopeSwitch = false
    private var recoveredFrom: CatalogPolicy.Receipt? = null
    private data class Preparation(val guard: String, val receipt: CatalogPolicy.Receipt,
        val artifact: LynxArtifactRequest?, val bytes: PreparedLynxArtifact?, val contextId: String)
    private data class LaunchPlan(
        val revision: String,
        val receipt: CatalogPolicy.Receipt,
        val files: VerifiedLynxInstallation,
        val confirmed: Boolean,
        val transition: JSONObject?,
    )
    private val preparations = mutableMapOf<String, Preparation>()
    private val preparing = mutableMapOf<String, String>()

    init {
        synchronized(stateLock) {
            if (!store.value.has("revision")) store.update { it.put("revision", UUID.randomUUID().toString()) }
            recover()
            if (!store.value.has("channel")) mutate { it.put("channel", configuration.channel) }
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
    private var runtimeCohort: String =
        store.value.optString("cohort").ifEmpty { configuration.cohort }
    private var runtimeChannel: String =
        store.value.optString("channel").ifEmpty { configuration.channel }
    private fun snapshot() = CatalogPolicy.NativeSnapshot(store.value.getString("revision"), configuration.appVersion,
        runtimeChannel, configuration.runtimeId, embedded.bundleId, configuration.minimumBundleId, runtimeCohort,
        running, receipt("next"), exclusions("crashed"), exclusions("unconfirmed"),
        configuration.fingerprintHash ?: binaryId)
    private fun selectionSnapshot(
        targetChannel: String,
        explicitScopeSwitch: Boolean,
        accepting: Boolean = false,
    ): CatalogPolicy.NativeSnapshot {
        CatalogPolicy.channelKey(targetChannel)
        if (explicitScopeSwitch != (targetChannel != runtimeChannel)) {
            throw CatalogPolicy.Rejected(
                if (accepting) "INVALID_SCOPE_SWITCH" else "STALE_SELECTION",
                "Catalog channel-switch intent no longer matches native state",
            )
        }
        if (!explicitScopeSwitch) return snapshot()
        if (runtimeChannel != configuration.channel) {
            throw CatalogPolicy.Rejected(
                if (accepting) "CHANNEL_ALREADY_SWITCHED" else "STALE_SELECTION",
                "Reset the current native channel before switching again",
            )
        }
        val minimumBase = CatalogPolicy.Receipt(
            "BUILTIN",
            null,
            configuration.minimumBundleId,
            null,
            null,
            null,
            null,
            targetChannel,
            null,
        )
        return CatalogPolicy.NativeSnapshot(
            store.value.getString("revision"),
            configuration.appVersion,
            targetChannel,
            configuration.runtimeId,
            embedded.bundleId,
            configuration.minimumBundleId,
            runtimeCohort,
            minimumBase,
            null,
            exclusions("crashed"),
            exclusions("unconfirmed"),
            configuration.fingerprintHash ?: binaryId,
        )
    }
    private fun mutate(change: (JSONObject) -> Unit) = store.update { change(it); it.put("revision", UUID.randomUUID().toString()) }
    private fun catalogKey(catalogId: String, scopeKey: String) =
        digestString("$catalogId\u0000$scopeKey")
    private fun parseHighWater(value: JSONObject) = CatalogPolicy.HighWater(
        value.getString("catalogId"),
        value.getString("scopeKey"),
        value.getLong("generation"),
        value.getString("catalogHash"),
    )
    private fun highWaterMark(value: CatalogPolicy.HighWater) = JSONObject()
        .put("catalogId", value.catalogId)
        .put("scopeKey", value.scopeKey)
        .put("generation", value.generation)
        .put("catalogHash", value.catalogHash)
    private fun highWater(catalogId: String? = null, scopeKey: String? = null): CatalogPolicy.HighWater? {
        if (!catalogId.isNullOrEmpty() && !scopeKey.isNullOrEmpty()) {
            store.value.optJSONObject("highWaters")?.optJSONObject(catalogKey(catalogId, scopeKey))
                ?.let { return parseHighWater(it) }
        }
        val single = store.value.optJSONObject("highWater") ?: return null
        if (
            catalogId.isNullOrEmpty() ||
            scopeKey.isNullOrEmpty() ||
            (single.optString("catalogId") == catalogId && single.optString("scopeKey") == scopeKey)
        ) {
            return parseHighWater(single)
        }
        return null
    }
    private fun recover() {
        val pending = store.value.optJSONObject("pending") ?: return
        val selected = CatalogPolicy.parseReceipt(pending.getJSONObject("selection"))
        recoveredFrom = selected
        val fallbackChannel = receipt("confirmed")?.channel ?: configuration.channel
        mutate { next ->
            if (selected.releaseId != null) {
                val key = if (pending.optBoolean("fatal") && selected.bundleId != embedded.bundleId) "crashed" else "unconfirmed"
                val id = if (key == "crashed") selected.bundleId else checkNotNull(selected.releaseId)
                val values = exclusions(key).toMutableSet().also { it.add(id) }
                next.put(key, JSONArray(values.toList()))
            }
            next.remove("pending")
            next.put("channel", fallbackChannel)
        }
        Log.i(TAG, "recovered release=${selected.releaseId} fatal=${pending.optBoolean("fatal")}")
    }
    private fun artifact(value: JSONObject) = LynxArtifactRequest.fromJson(value)
    private fun artifactJson(
        value: LynxArtifactRequest,
        verified: VerifiedLynxInstallation,
    ) = JSONObject()
        .put("bundleId", value.bundleId)
        .put(
            "fileHash",
            if (verified.manifestBacked) JSONObject.NULL else value.fileHash,
        )
        .put("manifestFileHash", value.manifestFileHash ?: JSONObject.NULL)
        .put("manifestBacked", verified.manifestBacked)
    private fun installed(value: CatalogPolicy.Receipt): VerifiedLynxInstallation {
        if (value.bundleId == embedded.bundleId) return embedded
        val record = checkNotNull(store.value.optJSONObject("artifacts")?.optJSONObject(value.bundleId)) { "No verified artifact receipt" }
        val root = File(directory, "artifacts/installations/${value.bundleId}")
        val integrity = ArchiveIntegrity(configuration.publicKeyPem)
        val manifestToken = record.opt("manifestFileHash").let {
            if (it == null || it == JSONObject.NULL) null else it as? String
                ?: error("Invalid installed manifest token")
        }
        val manifestBacked = record.optBoolean("manifestBacked", false)
        val archiveToken = record.opt("fileHash").let {
            if (it == null || it == JSONObject.NULL) null else it as? String
                ?: error("Invalid installed archive token")
        }
        if (manifestBacked) {
            require(!manifestToken.isNullOrBlank()) {
                "Manifest-backed installation lost its trust token"
            }
        } else {
            integrity.verify(File(root, "archive"), checkNotNull(archiveToken))
        }
        val request = LynxArtifactRequest(
            value.bundleId,
            null,
            archiveToken,
            manifestToken,
        )
        return LynxArtifactVerifier(
            LynxInstallConfiguration(configuration.runtimeId, configuration.publicKeyPem),
            integrity,
        ).verify(File(root, "payload"), request, manifestBacked).also {
            check(it.manifestHash == record.getString("verifiedManifestHash")) { "Installed manifest differs from the verified archive" }
        }
    }

    /** Call before creating/evaluating the designated primary Lynx view. */
    fun pinPrimary(): LynxLaunchSession {
        val plan = synchronized(stateLock) {
            check(!closed) { "The controller is closed" }
            check(primary == null) {
                "A new controller generation is required"
            }
            val startupSnapshot = snapshot()
            fun eligibleStored(candidate: CatalogPolicy.Receipt): Boolean {
                if (!eligible(candidate)) return false
                if (candidate.kind == "BUILTIN" && candidate.catalogId == null) return true
                val catalogId = candidate.catalogId ?: return false
                val scope = candidate.scopeKey ?: return false
                val key = catalogKey(catalogId, scope)
                val raw = store.value.optJSONObject("catalogs")?.optString(key)
                    ?.takeIf(String::isNotEmpty)
                    ?: store.value.optString("catalog").takeIf { value ->
                        if (value.isEmpty()) return@takeIf false
                        val stored = JSONObject(value)
                        stored.optString("catalogId") == catalogId &&
                            stored.optString("scopeKey") == scope
                    }
                    ?: return false
                val candidateSnapshot = CatalogPolicy.NativeSnapshot(
                    startupSnapshot.revision,
                    configuration.appVersion,
                    candidate.channel,
                    configuration.runtimeId,
                    embedded.bundleId,
                    configuration.minimumBundleId,
                    runtimeCohort,
                    candidate,
                    null,
                    exclusions("crashed"),
                    exclusions("unconfirmed"),
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
                val proof = store.value.optJSONObject("rollbackProofs")
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
            val confirmed = receipt("confirmed")?.takeIf(::eligibleStored)
            val atCapacity = exclusions("unconfirmed").size >= CAPACITY ||
                exclusions("crashed").size >= CAPACITY
            val candidates = listOfNotNull(
                receipt("next"),
                receipt("active"),
                confirmed,
                builtin(),
            ).distinct()
            var chosen = builtin()
            var files = embedded
            for (candidate in candidates) {
                if (
                    !eligibleStored(candidate) ||
                    atCapacity && candidate != confirmed &&
                    candidate.kind != "BUILTIN"
                ) {
                    continue
                }
                val verified = runCatching { installed(candidate) }.getOrNull()
                    ?: continue
                chosen = candidate
                files = verified
                break
            }
            val failed = recoveredFrom
            val stable = confirmed ?: builtin()
            val transition = if (failed != null) {
                launchTransition(failed, chosen, recovery = true)
            } else {
                launchTransition(stable, chosen)
            }
            LaunchPlan(
                store.value.getString("revision"),
                chosen,
                files,
                chosen == confirmed,
                transition,
            )
        }
        val lease = installer.retain(plan.files)
        try {
            return synchronized(stateLock) {
                check(!closed) { "The controller is closed" }
                check(
                    primary == null &&
                        store.value.getString("revision") == plan.revision,
                ) { "Primary selection changed during resource retention" }
                running = plan.receipt
                runningFiles = plan.files
                runningConfirmed = plan.confirmed
                val session = launchSession(
                    plan.files,
                    true,
                    plan.receipt.releaseId,
                    lease,
                )
                mutate { next ->
                    check(!next.has("pending")) {
                        "Existing startup attempt cannot be replaced"
                    }
                    next.put("active", plan.receipt.toJson())
                    next.remove("next")
                    if (plan.transition != null) {
                        next.put("launchTransition", plan.transition)
                    } else {
                        val stored = next.optJSONObject("launchTransition")
                        val storedTarget = runCatching {
                            stored?.getJSONObject("to")
                                ?.let(CatalogPolicy::parseReceipt)
                        }.getOrNull()
                        if (stored != null && storedTarget != plan.receipt) {
                            next.remove("launchTransition")
                        }
                    }
                    if (!runningConfirmed) {
                        next.put(
                            "pending",
                            JSONObject()
                                .put("attemptId", session.id)
                                .put("selection", plan.receipt.toJson())
                                .put("fatal", false),
                        )
                    }
                }
                recoveredFrom = null
                primary = session
                Log.i(
                    TAG,
                    "attempt-before-evaluation bundle=${plan.receipt.bundleId} release=${plan.receipt.releaseId} confirmed=$runningConfirmed attempt=${session.id}",
                )
                session
            }
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
    }

    fun pinSecondary(): LynxLaunchSession {
        val plan = synchronized(stateLock) {
            check(!closed) { "The controller is closed" }
            check(primary != null) {
                "Secondary context must wait for primary selection"
            }
            Triple(runningFiles, running, checkNotNull(primary))
        }
        val lease = installer.retain(plan.first)
        try {
            return synchronized(stateLock) {
                check(
                    !closed && primary === plan.third &&
                        running == plan.second && runningFiles === plan.first,
                ) { "Primary selection changed during resource retention" }
                launchSession(
                    plan.first,
                    false,
                    plan.second.releaseId,
                    lease,
                )
            }
        } catch (error: Throwable) {
            lease.close()
            throw error
        }
    }

    private fun launchSession(
        files: VerifiedLynxInstallation,
        isPrimary: Boolean,
        releaseId: String?,
        lease: InstallationLease,
    ): LynxLaunchSession {
        val id = UUID.randomUUID().toString()
        return LynxLaunchSession(
            this,
            files,
            id,
            isPrimary,
            releaseId,
            File(directory, "resource-snapshots/$id"),
            lease,
        )
    }

    fun diagnostics(session: LynxLaunchSession): LynxLaunchDiagnostics =
        synchronized(stateLock) {
            requireLive(session, false)
            LynxLaunchDiagnostics(
                contextId = session.id,
                startupAttemptId = checkNotNull(primary).id,
                bundleId = session.installation.bundleId,
                releaseId = session.launchReleaseId,
            )
        }

    fun setCohort(cohort: String) {
        val normalized = CatalogPolicy.normalizedCohort(cohort)
        synchronized(stateLock) {
            check(!closed) { "The controller is closed" }
            mutate { it.put("cohort", normalized) }
            runtimeCohort = normalized
        }
    }
    internal fun setChannel(channel: String) = synchronized(stateLock) {
        check(!closed) { "The controller is closed" }
        runtimeChannel = channel
        mutate { it.put("channel", channel) }
    }
    fun resetChannel(): Boolean {
        val discarded = synchronized(stateLock) {
            check(!closed) { "The controller is closed" }
            mutate { next ->
                next.put("channel", configuration.channel)
                next.put("active", builtin().toJson())
                next.remove("next")
                next.remove("confirmed")
                next.remove("pending")
            }
            runtimeChannel = configuration.channel
            accepted = null
            acceptedScopeSwitch = false
            preparations.values.mapNotNull(Preparation::bytes).also {
                preparations.clear()
                preparing.clear()
            }
        }
        discarded.forEach(installer::discard)
        return true
    }
    fun clearCrashHistory() = synchronized(stateLock) {
        check(!closed) { "The controller is closed" }
        mutate { it.put("crashed", JSONArray()) }
    }

    internal fun state(session: LynxLaunchSession): JSONObject = synchronized(stateLock) {
        requireLive(session, false)
        val state = snapshot()
        JSONObject().put("revision", state.revision).put("platform", "android").put("appVersion", state.appVersion)
            .put("channel", state.channel).put("defaultChannel", configuration.channel)
            .put("channelKey", CatalogPolicy.channelKey(state.channel)).put("runtimeId", state.runtimeId).put("embeddedBundleId", state.embeddedBundleId)
            .put("minimumBundleId", state.minimumBundleId).put("cohort", state.cohort)
            .put("runningSelection", running.toJson()).put("runningConfirmed", runningConfirmed)
            .put("confirmedSelection", receipt("confirmed")?.toJson() ?: JSONObject.NULL)
            .put("nextSelection", receipt("next")?.toJson() ?: JSONObject.NULL)
            .put("crashedBundleIds", JSONArray(state.crashedBundleIds)).put("unconfirmedReleaseIds", JSONArray(state.unconfirmedReleaseIds))
            .put("fingerprintHash", configuration.fingerprintHash ?: binaryId)
    }

    internal fun accept(session: LynxLaunchSession, params: JSONObject): JSONObject = synchronized(stateLock) {
        requireLive(session)
        val targetChannel = params.getString("targetChannel")
        val explicitScopeSwitch = params.opt("explicitScopeSwitch") as? Boolean
            ?: throw CatalogPolicy.Rejected(
                "INVALID_SCOPE_SWITCH",
                "Catalog channel-switch intent must be boolean",
            )
        val incoming = params.getJSONObject("catalog")
        val raw = incoming.toString()
        val incomingId = incoming.getString("catalogId")
        val incomingScope = incoming.getString("scopeKey")
        val before = selectionSnapshot(
            targetChannel,
            explicitScopeSwitch,
            accepting = true,
        )
        val mark = highWater(incomingId, incomingScope)
        // Persisted raw projection also binds same generation/hash bodies after recreation.
        val previous = runCatching {
            val inMemory = accepted
            if (
                inMemory != null &&
                inMemory.guard.catalogId == incomingId &&
                inMemory.guard.scopeKey == incomingScope
            ) {
                inMemory
            } else {
                store.value.optString("catalog").takeIf { it.isNotEmpty() }?.let {
                    val stored = JSONObject(it)
                    if (
                        stored.optString("catalogId") != incomingId ||
                        stored.optString("scopeKey") != incomingScope
                    ) {
                        null
                    } else {
                        CatalogPolicy.accept(
                            it,
                            before,
                            before.revision,
                            CatalogPolicy.selectionContextHash(before, incomingScope),
                            mark,
                        )
                    }
                }
            }
        }.getOrNull()
        val checked = CatalogPolicy.accept(
            raw,
            before,
            params.getString("expectedRevision"),
            params.getString("selectionContextHash"),
            mark,
            previous,
        )
        mutate { next ->
            next.put("catalog", raw)
            val catalogs = next.optJSONObject("catalogs") ?: JSONObject()
            catalogs.put(catalogKey(incomingId, incomingScope), raw)
            next.put("catalogs", catalogs)
            val waters = next.optJSONObject("highWaters") ?: JSONObject()
            val recorded = highWaterMark(checked.highWater)
            waters.put(catalogKey(checked.guard.catalogId, checked.guard.scopeKey), recorded)
            next.put("highWaters", waters)
            next.put("highWater", recorded)
        }
        val after = selectionSnapshot(targetChannel, explicitScopeSwitch)
        accepted = CatalogPolicy.accept(
            raw,
            after,
            after.revision,
            CatalogPolicy.selectionContextHash(after, checked.guard.scopeKey),
            highWater(checked.guard.catalogId, checked.guard.scopeKey),
            checked,
        )
        acceptedScopeSwitch = explicitScopeSwitch
        checkNotNull(accepted).guard.toJson()
    }

    internal suspend fun prepare(session: LynxLaunchSession, params: JSONObject): JSONObject {
        val guard = params.getJSONObject("guard").toString()
        val selected = CatalogPolicy.parseReceipt(params.getJSONObject("selection"))
        val request = params.optJSONObject("artifact")?.let(::artifact)
        val cacheKey = request?.let { digestString("${it.bundleId}\n${it.fileHash}\n${it.manifestFileHash}") }
        val reservation = UUID.randomUUID().toString()
        var deltaBase: VerifiedLynxInstallation? = null
        synchronized(stateLock) {
            authorize(session, guard, selected)
            check(preparations.size + preparing.size < 16) { "Too many outstanding preparations" }
            if (cacheKey != null && store.value.optJSONObject("incompatible")?.has(cacheKey) == true) throw LynxIncompatibleArtifactException("Cached native incompatibility")
            if (selected.kind == "BUNDLE" && !(runningConfirmed && selected.bundleId == running.bundleId)) require(request?.bundleId == selected.bundleId) { "Selection requires its archive receipt" }
            if (request != null) require(request.bundleId == selected.bundleId) { "Archive Bundle does not match selection" }
            deltaBase = runningFiles
            preparing[reservation] = selected.bundleId
        }
        Log.i(
            TAG,
            "prepare-selection bundle=${selected.bundleId} release=${selected.releaseId} artifact=${request != null}",
        )
        var bytes: PreparedLynxArtifact? = null
        try {
            if (request != null) {
                bytes = installer.prepare(
                    request,
                    deltaBase,
                    releaseId = selected.releaseId,
                )
            }
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
            if (error is LynxIncompatibleArtifactException && cacheKey != null) {
                synchronized(stateLock) {
                    if (!closed) {
                        store.update { next ->
                            val cache = next.optJSONObject("incompatible") ?: JSONObject()
                            if (cache.length() >= CAPACITY) cache.keys().asSequence().minByOrNull { cache.getLong(it) }?.let(cache::remove)
                            cache.put(cacheKey, System.currentTimeMillis()); next.put("incompatible", cache)
                        }
                    }
                }
            }
            throw error
        } finally { synchronized(stateLock) { preparing.remove(reservation) } }
    }

    internal suspend fun stage(session: LynxLaunchSession, id: String): JSONObject {
        val prepared = takePreparation(session, id)
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
                    val installed = checkNotNull(verified)
                    records.put(
                        input.bundleId,
                        artifactJson(input, installed)
                            .put("verifiedManifestHash", installed.manifestHash),
                    )
                    next.put("artifacts", records)
                }
                if (adoption) {
                    next.put("active", selected.toJson())
                    next.put("confirmed", selected.toJson())
                    next.remove("next")
                    launchTransition(running, selected)?.let {
                        next.put("launchTransition", it)
                    }
                } else {
                    next.put("next", selected.toJson())
                    if (selected.kind == "BUILTIN") next.remove("confirmed")
                }
                next.put("channel", selected.channel)
            }
            if (adoption) running = selected
            runtimeChannel = selected.channel
            result = JSONObject().put("status", if (adoption) "ADOPTED" else "STAGED").put("requiresRestart", !adoption)
            Log.i(TAG, "selection-${if (adoption) "adopted" else "staged"} bundle=${selected.bundleId} release=${selected.releaseId} running=${running.bundleId}")
        }
        try {
            synchronized(stateLock) { requireLive(session) }
            if (prepared.bytes != null) installer.commitPrepared(prepared.bytes) { publish ->
                synchronized(stateLock) { val authorization = authorize(session, prepared.guard, prepared.receipt); publish().also { publishSelection(authorization, it) } }
            } else synchronized(stateLock) { val authorization = authorize(session, prepared.guard, prepared.receipt); publishSelection(authorization) }
            pruneUnused()
            return checkNotNull(result)
        } finally {
            prepared.bytes?.let(installer::discard)
        }
    }

    internal suspend fun validate(
        session: LynxLaunchSession,
        params: JSONObject,
    ): JSONObject {
        val id = prepare(session, params).getString("preparedId")
        val prepared = takePreparation(session, id)
        try {
            synchronized(stateLock) {
                authorize(session, prepared.guard, prepared.receipt)
            }
            return JSONObject().put("validated", true)
        } finally {
            prepared.bytes?.let(installer::discard)
        }
    }

    private fun takePreparation(
        session: LynxLaunchSession,
        id: String,
    ): Preparation = synchronized(stateLock) {
        val owned = checkNotNull(
            preparations[id]?.takeIf { it.contextId == session.id },
        ) { "Unknown prepared selection" }
        preparations.remove(id)
        owned
    }

    private fun receiptKey(receipt: CatalogPolicy.Receipt) = digestString(receipt.toJson().toString())
    private fun authorize(session: LynxLaunchSession, guard: String, selected: CatalogPolicy.Receipt): CatalogPolicy.AuthorizedSelection {
        requireLive(session)
        val catalog = checkNotNull(accepted) { "No accepted native catalog" }
        return CatalogPolicy.verifySelection(
            catalog,
            selectionSnapshot(catalog.guard.channel, acceptedScopeSwitch),
            guard,
            selected.toJson().toString(),
        )
    }
    private fun requireLive(session: LynxLaunchSession, primaryOnly: Boolean = true) {
        if (closed || !session.live || session.controller !== this || (primaryOnly && session !== primary)) throw CatalogPolicy.Rejected("STALE_CONTEXT", "The calling native context is not eligible")
    }
    private fun sameRelease(
        first: CatalogPolicy.Receipt,
        second: CatalogPolicy.Receipt,
    ) = first.bundleId == second.bundleId && first.releaseId == second.releaseId

    private fun launchTransition(
        from: CatalogPolicy.Receipt,
        to: CatalogPolicy.Receipt,
        recovery: Boolean = false,
    ): JSONObject? {
        if (sameRelease(from, to)) return null
        val kind = when {
            recovery -> "RECOVERED"
            from.bundleId != to.bundleId -> "UPDATE_APPLIED"
            from.releaseId != null && to.releaseId != null &&
                from.releaseId != to.releaseId -> "UNCHANGED"
            else -> return null
        }
        return JSONObject()
            .put("kind", kind)
            .put("from", from.toJson())
            .put("to", to.toJson())
    }

    private fun transitionResponse(value: JSONObject?): Any {
        if (value == null) return JSONObject.NULL
        val kind = value.getString("kind")
        val from = CatalogPolicy.parseReceipt(value.getJSONObject("from"))
        val to = CatalogPolicy.parseReceipt(value.getJSONObject("to"))
        check(to == running) { "Launch transition target is not running" }
        check(!sameRelease(from, to)) { "Launch transition identity did not change" }
        check(
            when (kind) {
                "UPDATE_APPLIED" -> from.bundleId != to.bundleId
                "RECOVERED" -> true
                "UNCHANGED" -> from.bundleId == to.bundleId &&
                    from.releaseId != null && to.releaseId != null &&
                    from.releaseId != to.releaseId
                else -> false
            },
        ) { "Invalid launch transition" }
        fun summary(receipt: CatalogPolicy.Receipt) = JSONObject()
            .put("kind", receipt.kind)
            .put("releaseId", receipt.releaseId ?: JSONObject.NULL)
            .put("bundleId", receipt.bundleId)
            .put("channel", receipt.channel)
        return JSONObject()
            .put("kind", kind)
            .put(
                "from",
                summary(from),
            )
            .put(
                "to",
                summary(to),
            )
    }

    internal fun confirm(session: LynxLaunchSession): JSONObject = synchronized(stateLock) {
        requireLive(session)
        check(session.firstScreen && !session.failed) { "Primary content is not ready" }
        val transition = store.value.optJSONObject("launchTransition")
        if (runningConfirmed) {
            if (transition != null) mutate { it.remove("launchTransition") }
            return JSONObject()
                .put("status", "ALREADY_CONFIRMED")
                .put("transition", transitionResponse(transition))
        }
        val pending = store.value.optJSONObject("pending")
        check(pending?.optString("attemptId") == session.id && !pending.optBoolean("fatal")) { "Startup attempt cannot be confirmed" }
        check(eligible(running)) { "Running selection is excluded" }
        mutate {
            it.remove("pending")
            it.put("confirmed", running.toJson())
            it.remove("launchTransition")
        }
        runningConfirmed = true
        Log.i(TAG, "confirmed bundle=${running.bundleId} release=${running.releaseId} attempt=${session.id}")
        JSONObject()
            .put("status", "CONFIRMED")
            .put("transition", transitionResponse(transition))
    }
    internal fun fail(
        session: LynxLaunchSession,
        message: String,
        allowConfirmed: Boolean = false,
    ): Boolean {
        return synchronized(stateLock) {
            if (closed || session !== primary || !session.live || runningConfirmed && !allowConfirmed) return@synchronized false
            if (session.failed) return@synchronized true
            val pending = store.value.optJSONObject("pending")
            if (!runningConfirmed &&
                pending?.optString("attemptId") != session.id) {
                return@synchronized false
            }
            if (pending?.optBoolean("fatal") == true) {
                session.failed = true
                return@synchronized true
            }
            mutate { next ->
                if (pending != null) {
                    next.put("pending", JSONObject(pending.toString()).put("fatal", true).put("message", message))
                }
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
            session.failed = true
            true
        }
    }
    internal fun destroy(session: LynxLaunchSession) {
        val (discarded, shouldPrune) = synchronized(stateLock) {
            session.live = false
            if (closed) return@synchronized emptyList<PreparedLynxArtifact>() to false
            val ids = preparations.filterValues { it.contextId == session.id }.keys.toList()
            ids.mapNotNull { preparations.remove(it)?.bytes } to true
        }
        discarded.forEach(installer::discard)
        if (shouldPrune) pruneUnused()
    }
    private fun pruneUnused() {
        synchronized(stateLock) { if (closed) return }
        runCatching { installer.prune { removeUnused -> synchronized(stateLock) {
            if (closed) return@synchronized
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
    fun close() {
        val prepared = synchronized(stateLock) {
            if (closed) return
            closed = true
            primary?.live = false
            preparations.values.mapNotNull(Preparation::bytes).also {
                preparations.clear()
                preparing.clear()
                accepted = null
                acceptedScopeSwitch = false
            }
        }
        try {
            prepared.forEach(installer::discard)
        } finally {
            store.close()
        }
    }
    companion object { private const val TAG = "HotUpdaterLynx"; private const val CAPACITY = 128 }
}
