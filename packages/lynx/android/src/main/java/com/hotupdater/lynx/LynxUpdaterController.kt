package com.hotupdater.lynx

import android.content.Context
import android.os.Process
import android.util.Log
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.HashUtils
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlin.coroutines.coroutineContext

data class LynxLaunchDiagnostics(
    val contextId: String,
    val startupAttemptId: String,
    val bundleId: String,
    val releaseId: String?,
    val generationId: String,
    val pageEntry: String,
    val pageAttemptId: String?,
)

/** Native policy, scoped persistence and immutable process selection. */
class LynxUpdaterController internal constructor(
    private val filesDir: File,
    packageCodePath: File,
    private val embedded: VerifiedLynxInstallation,
    val configuration: LynxHostConfiguration,
    private val processIdentity: () -> String = {
        Process.myPid().toString()
    },
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
    private val generationEventJournal = LynxGenerationEventJournal(filesDir)
    private val store = LynxStateStore(directory)
    private val installer = LynxArtifactInstaller(File(directory, "artifacts"), LynxInstallConfiguration(configuration.runtimeId, configuration.publicKeyPem))
    private var running = builtin()
    private var runningFiles = embedded
    private var runningConfirmed = false
    private var closed = false
    private var primary: LynxLaunchSession? = null
    private val members = linkedSetOf<LynxLaunchSession>()
    private var accepted: CatalogPolicy.AcceptedCatalog? = null
    private var acceptedScopeSwitch = false
    private data class Preparation(val guard: String, val receipt: CatalogPolicy.Receipt,
        val artifact: LynxArtifactRequest?, val bytes: PreparedLynxArtifact?, val contextId: String)
    private data class LaunchPlan(
        val revision: String,
        val receipt: CatalogPolicy.Receipt,
        val files: VerifiedLynxInstallation,
        val confirmed: Boolean,
        val transition: JSONObject?,
        val logicalStack: List<LynxLogicalPage>,
    )
    private data class SecondaryPlan(
        val files: VerifiedLynxInstallation,
        val receipt: CatalogPolicy.Receipt,
        val primary: LynxLaunchSession,
        val stack: List<LynxLogicalPage>,
        val page: LynxLogicalPage,
    )
    private val preparations = mutableMapOf<String, Preparation>()
    private val preparing = mutableMapOf<String, String>()

    init {
        LynxReleaseResources.cleanOrphanedSnapshots(
            File(directory, "resource-snapshots"),
        )
        synchronized(stateLock) {
            if (!store.value.has("revision")) store.update { it.put("revision", UUID.randomUUID().toString()) }
            normalizeStoredLaunchTransition()
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

    private data class StoredFallback(
        val receipt: CatalogPolicy.Receipt,
        val files: VerifiedLynxInstallation,
        val confirmed: CatalogPolicy.Receipt?,
    )

    private fun eligibleStored(
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
            return true
        }
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
            store.value.getString("revision"),
            configuration.appVersion,
            candidate.channel,
            configuration.runtimeId,
            embedded.bundleId,
            configuration.minimumBundleId,
            store.value.optString("cohort").ifEmpty { configuration.cohort },
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

    private fun storedFallback(
        stack: List<LynxLogicalPage>,
        crashed: List<String>,
        unconfirmed: List<String>,
        failedEmbedded: CatalogPolicy.Receipt?,
    ): StoredFallback? {
        fun eligible(candidate: CatalogPolicy.Receipt) = eligibleStored(
            candidate,
            crashed,
            unconfirmed,
            failedEmbedded,
        )
        val confirmed = receipt("confirmed")?.takeIf(::eligible)
        val atCapacity = unconfirmed.size >= CAPACITY || crashed.size >= CAPACITY
        val candidates = listOfNotNull(
            receipt("next"),
            receipt("active"),
            confirmed,
            builtin(),
        ).distinct()
        for (candidate in candidates) {
            if (
                !eligible(candidate) ||
                atCapacity && candidate != confirmed && candidate.kind != "BUILTIN"
            ) {
                continue
            }
            val files = runCatching { installed(candidate) }.getOrNull()
                ?: continue
            if (runCatching { requireCompleteStack(files, stack) }.isFailure) {
                continue
            }
            return StoredFallback(candidate, files, confirmed)
        }
        return null
    }

    private fun recover() {
        replayPageAttemptTerminals()
        val pendingPage = store.value.optJSONObject("pageAttempt")
        val pending = store.value.optJSONObject("pending")
        val generationFailure = store.value.optJSONObject("generationFailure")
        if (pendingPage == null && pending == null && generationFailure == null) {
            return
        }
        val selected = CatalogPolicy.parseReceipt(
            (pendingPage ?: pending ?: checkNotNull(generationFailure))
                .getJSONObject("selection"),
        )
        val stable = receipt("confirmed") ?: builtin()
        val managedTransitionId = store.value.optJSONObject("managedTransition")
            ?.let(::transitionId)
        val pendingTransitionId = pending?.opt("transitionId") as? String
        if (pendingTransitionId != null) {
            check(isCanonicalTransitionId(pendingTransitionId)) {
                "Pending transition identifier is invalid"
            }
            check(pendingTransitionId == managedTransitionId) {
                "Pending managed transition identity changed"
            }
        }
        val recoveredTransitionId = pendingTransitionId
            ?: managedTransitionId?.takeIf {
                pending != null || pendingPage != null ||
                    generationFailure != null
            }
        val benignConfirmedManagedReload =
            pending != null && pendingPage == null && generationFailure == null &&
                pendingTransitionId != null &&
                pendingTransitionId == managedTransitionId &&
                sameRelease(selected, stable)
        val fatal = pendingPage?.optBoolean("fatal") == true ||
            pending?.optBoolean("fatal") == true ||
            generationFailure?.optBoolean("fatal") == true
        val nextUnconfirmed = exclusions("unconfirmed").toMutableSet()
        val nextCrashed = exclusions("crashed").toMutableSet()
        if (!benignConfirmedManagedReload && selected.releaseId != null) {
            nextUnconfirmed.add(checkNotNull(selected.releaseId))
        }
        if (fatal && selected.bundleId != embedded.bundleId) {
            nextCrashed.add(selected.bundleId)
        }
        val failedEmbedded = selected.takeIf {
            !benignConfirmedManagedReload &&
                it.bundleId == embedded.bundleId &&
                (pendingPage != null || generationFailure != null)
        }
        val fallback = if (benignConfirmedManagedReload) {
            null
        } else {
            storedFallback(
                retainedStack(),
                nextCrashed.toList(),
                nextUnconfirmed.toList(),
                failedEmbedded,
            )
        }
        val recoveryTransition = fallback?.receipt?.let {
            launchTransition(selected, it, recovery = true)
        }
        val recoveryTransitionId = recoveredTransitionId
            ?: recoveryTransition?.let(::transitionId)
        val fallbackChannel = fallback?.receipt?.channel ?: stable.channel
        mutate { next ->
            pendingPage?.let { pageAttempt ->
                appendPageAttemptTerminal(
                    next = next,
                    attempt = pageAttempt,
                    terminal = "process-interruption",
                    stack = retainedStack(),
                    reason = "processRecovery",
                    transitionId = recoveryTransitionId,
                    topContextId = null,
                )
            }
            if (!benignConfirmedManagedReload && selected.releaseId != null) {
                next.put("unconfirmed", JSONArray(nextUnconfirmed.toList()))
            }
            if (fatal && selected.bundleId != embedded.bundleId) {
                next.put("crashed", JSONArray(nextCrashed.toList()))
            }
            if (failedEmbedded != null) {
                next.put("failedEmbedded", failedEmbedded.toJson())
            }
            next.remove("pending")
            next.remove("pageAttempt")
            next.remove("generationFailure")
            if (recoveryTransition != null) {
                next.put("launchTransition", recoveryTransition)
            } else if (
                benignConfirmedManagedReload || recoveredTransitionId != null ||
                fallback == null
            ) {
                next.remove("launchTransition")
            }
            if (recoveredTransitionId != null) {
                next.remove("managedTransition")
            }
            next.put("channel", fallbackChannel)
        }
        replayPageAttemptTerminals()
        Log.i(
            TAG,
            "recovered release=${selected.releaseId} fatal=" +
                (pendingPage?.optBoolean("fatal") == true ||
                    pending?.optBoolean("fatal") == true ||
                    generationFailure?.optBoolean("fatal") == true),
        )
    }

    private fun replayPageAttemptTerminals() {
        val terminals = store.value.optJSONArray("pageAttemptTerminals") ?: return
        for (index in 0 until terminals.length()) {
            val terminal = terminals.getJSONObject(index)
            if (terminal.optBoolean("runtimeEventEmitted", false)) continue
            val pageAttemptId = terminal.getString("attemptId")
            val selection = CatalogPolicy.parseReceipt(
                terminal.getJSONObject("selection"),
            )
            val stack = parseStack(terminal.getJSONArray("stack"))
            val details = mutableMapOf<String, Any?>(
                "runtimeId" to configuration.runtimeId,
                "processId" to terminal.getString("processId"),
                "generationId" to terminal.getString("generationId"),
                "contextId" to terminal.getString("contextId"),
                "attemptId" to terminal.getString("startupAttemptId"),
                "pageAttemptId" to pageAttemptId,
                "bundleId" to selection.bundleId,
                "releaseId" to selection.releaseId,
                "pageEntry" to terminal.getString("entry"),
                "pageParameters" to terminal.getJSONObject("parameters").let {
                    parameters -> parameters.keys().asSequence().associateWith {
                        key -> parameters.getString(key)
                    }
                },
                "nativePageClass" to terminal.optString("nativePageClass")
                    .takeIf(String::isNotEmpty),
                "sourceContextId" to terminal.getString("sourceContextId"),
                "orderedPageEntries" to stack.map(LynxLogicalPage::entry),
                "orderedPageParameters" to stack.map(LynxLogicalPage::parameters),
                "topPageEntry" to terminalTopPage(terminal, stack)?.entry,
                "topContextId" to terminal.optString("topContextId")
                    .takeIf(String::isNotEmpty),
                "transitionId" to terminal.optString("transitionId")
                    .takeIf(String::isNotEmpty),
                "terminal" to terminal.getString("terminal"),
            )
            terminal.optString("reason").takeIf(String::isNotEmpty)
                ?.let { details["reason"] = it }
            terminal.opt("failureCode")?.takeUnless { it == JSONObject.NULL }
                ?.let { details["failureCode"] = it }
            terminal.optString("failureResourcePath").takeIf(String::isNotEmpty)
                ?.let { details["failureResourcePath"] = it }
            val recorded = runCatching {
                generationEventJournal.appendOnce(
                    "pageAttemptTerminal",
                    "pageAttemptId",
                    pageAttemptId,
                    details,
                )
            }
            if (recorded.isFailure) {
                Log.e(TAG, "Deferred page terminal runtime event recording", recorded.exceptionOrNull())
                return
            }
            if (runCatching { markPageAttemptTerminalEventEmitted(pageAttemptId) }.isFailure) {
                Log.e(TAG, "Deferred page terminal emission marker")
                return
            }
        }
    }
    private fun artifact(value: JSONObject) = LynxArtifactRequest.fromJson(value)

    private fun pageJson(value: LynxLogicalPage) = JSONObject()
        .put("entry", value.entry)
        .put("parameters", JSONObject(value.parameters))

    private fun stackJson(value: List<LynxLogicalPage>) = JSONArray(
        value.map(::pageJson),
    )

    private fun appendPageAttemptTerminal(
        next: JSONObject,
        attempt: JSONObject,
        terminal: String,
        stack: List<LynxLogicalPage>,
        reason: String? = null,
        transitionId: String? = null,
        topContextId: String?,
        message: String? = null,
        failureCode: Int? = null,
        failureResourcePath: String? = null,
    ) {
        val attemptId = attempt.getString("attemptId")
        val terminals = next.optJSONArray("pageAttemptTerminals") ?: JSONArray()
        check((0 until terminals.length()).none { index ->
            terminals.getJSONObject(index).getString("attemptId") == attemptId
        }) { "Page attempt already has a terminal record" }
        val record = JSONObject(attempt.toString())
            .put("contextId", attemptId)
            .put("processId", attempt.getString("processId"))
            .put("stack", stackJson(stack))
            .put("terminal", terminal)
            .put("topContextId", topContextId ?: JSONObject.NULL)
            .put("transitionId", transitionId ?: JSONObject.NULL)
            .put("runtimeEventEmitted", false)
        reason?.let { record.put("reason", it) }
        message?.let { record.put("message", it) }
        failureCode?.let { record.put("failureCode", it) }
        failureResourcePath?.let { record.put("failureResourcePath", it) }
        terminals.put(record)
        while (terminals.length() > PAGE_ATTEMPT_TERMINAL_CAPACITY) {
            terminals.remove(0)
        }
        next.put("pageAttemptTerminals", terminals)
        next.put(
            "pageAttemptTerminalCount",
            next.optLong("pageAttemptTerminalCount", 0L) + 1L,
        )
        next.put("lastPageAttempt", JSONObject(record.toString()))
    }

    private fun liveTopContextId(
        stack: List<LynxLogicalPage>,
        excludingAttemptId: String,
    ): String? {
        val top = stack.lastOrNull() ?: return null
        return members.toList().asReversed().firstOrNull { session ->
            session.id != excludingAttemptId && session.live && !session.failed &&
                session.generationId == primary?.generationId &&
                session.pageEntry == top.entry &&
                session.pageParameters == top.parameters
        }?.id
    }

    private fun stackBeforeAttempt(
        stack: List<LynxLogicalPage>,
        attempt: JSONObject,
    ): List<LynxLogicalPage> = stack.take(
        attempt.getInt("position").coerceIn(0, stack.size),
    )

    private fun terminalTopPage(
        terminal: JSONObject,
        stack: List<LynxLogicalPage>,
    ): LynxLogicalPage? = if (
        terminal.getString("terminal") == "authorized-cancel"
    ) {
        stack.lastOrNull()
    } else {
        stack.getOrNull(terminal.getInt("position")) ?: stack.lastOrNull()
    }

    fun markPageAttemptTerminalEventEmitted(pageAttemptId: String): Boolean =
        synchronized(stateLock) {
            val terminals = store.value.optJSONArray("pageAttemptTerminals")
                ?: return@synchronized false
            val index = (0 until terminals.length()).firstOrNull { index ->
                terminals.getJSONObject(index).getString("attemptId") == pageAttemptId
            } ?: return@synchronized false
            if (terminals.getJSONObject(index).optBoolean("runtimeEventEmitted")) {
                return@synchronized true
            }
            mutate { next ->
                val stored = next.getJSONArray("pageAttemptTerminals")
                    .getJSONObject(index)
                check(stored.getString("attemptId") == pageAttemptId)
                stored.put("runtimeEventEmitted", true)
                next.optJSONObject("lastPageAttempt")?.takeIf {
                    it.optString("attemptId") == pageAttemptId
                }?.put("runtimeEventEmitted", true)
            }
            true
        }

    private fun parseStack(value: JSONArray): List<LynxLogicalPage> =
        (0 until value.length()).map { index ->
            val page = value.optJSONObject(index)
                ?: error("Invalid managed logical page")
            require(page.keys().asSequence().toSet() == setOf("entry", "parameters")) {
                "Invalid managed logical page keys"
            }
            val parameters = page.optJSONObject("parameters")
                ?: error("Invalid managed page parameters")
            val values = parameters.keys().asSequence().associateWith { key ->
                require(key.isNotEmpty()) { "Invalid managed page parameter" }
                parameters.opt(key) as? String
                    ?: error("Managed page parameters must be strings")
            }
            LynxLogicalPage(page.getString("entry"), values)
        }.also { stack ->
            require(stack.isNotEmpty() && stack.size <= MAX_MANAGED_PAGES) {
                "Invalid managed logical stack size"
            }
        }

    private fun retainedStack(): List<LynxLogicalPage> {
        val transition = store.value.optJSONObject("managedTransition")
        val stored = store.value.optJSONArray("logicalStack")
            ?: transition?.optJSONArray("stack")
        return stored?.let(::parseStack) ?: listOf(
            LynxLogicalPage(embedded.entry),
        )
    }

    private fun requireCompleteStack(
        installation: VerifiedLynxInstallation,
        stack: List<LynxLogicalPage>,
    ) {
        require(stack.first().entry == installation.entry) {
            "Managed logical stack does not begin with the artifact main entry"
        }
        stack.forEach { page ->
            require(page.entry in installation.pageEntries) {
                "Selected artifact cannot reconstruct the complete page stack"
            }
        }
    }
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
    fun pinPrimary(
        generationId: String = UUID.randomUUID().toString(),
        parameters: Map<String, String> = emptyMap(),
    ): LynxLaunchSession {
        val plan = synchronized(stateLock) {
            check(!closed) { "The controller is closed" }
            check(primary == null) {
                "A new controller generation is required"
            }
            val stack = retainedStack().let { retained ->
                if (
                    store.value.has("logicalStack") ||
                    store.value.has("managedTransition")
                ) {
                    retained
                } else {
                    listOf(LynxLogicalPage(embedded.entry, parameters))
                }
            }
            val fallback = checkNotNull(
                storedFallback(
                    stack,
                    exclusions("crashed"),
                    exclusions("unconfirmed"),
                    store.value.optJSONObject("failedEmbedded")
                        ?.let(CatalogPolicy::parseReceipt),
                ),
            ) {
                "No eligible complete Lynx page generation can be reconstructed"
            }
            val selected = fallback.receipt
            val selectedFiles = checkNotNull(fallback.files)
            val stable = fallback.confirmed ?: builtin()
            val transition = launchTransition(stable, selected)
            LaunchPlan(
                store.value.getString("revision"),
                selected,
                selectedFiles,
                selected == fallback.confirmed,
                transition,
                stack,
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
                    page = plan.logicalStack.first(),
                    generationId = generationId,
                )
                mutate { next ->
                    check(!next.has("pending")) {
                        "Existing startup attempt cannot be replaced"
                    }
                    next.put("active", plan.receipt.toJson())
                    next.remove("next")
                    next.put("logicalStack", stackJson(plan.logicalStack))
                    if (plan.logicalStack.size > 1) {
                        next.put("reconstructionPosition", 1)
                    } else {
                        next.remove("reconstructionPosition")
                    }
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
                    val managedTransitionId = next
                        .optJSONObject("managedTransition")
                        ?.let(::transitionId)
                    if (!runningConfirmed || managedTransitionId != null) {
                        next.put(
                            "pending",
                            JSONObject()
                                .put("attemptId", session.id)
                                .put("selection", plan.receipt.toJson())
                                .put("fatal", false)
                                .also { pending ->
                                    managedTransitionId?.let {
                                        pending.put("transitionId", it)
                                    }
                                },
                        )
                    }
                }
                primary = session
                members.add(session)
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

    @Deprecated("Pass an allowlisted page entry and logical stack identity")
    fun pinSecondary(): LynxLaunchSession {
        val source = synchronized(stateLock) {
            checkNotNull(primary) { "Secondary context must wait for primary selection" }
        }
        return pinSecondary(
            pageEntry = source.pageEntry,
            parameters = emptyMap(),
            stackPosition = retainedLogicalStack(source).size,
            generationId = source.generationId,
        )
    }

    fun pinSecondary(
        pageEntry: String,
        parameters: Map<String, String>,
        stackPosition: Int,
        generationId: String,
        reconstructing: Boolean = false,
        nativePageClass: String? = null,
        sourceContextId: String? = null,
    ): LynxLaunchSession {
        val plan = synchronized(stateLock) {
            check(!closed) { "The controller is closed" }
            val currentPrimary = checkNotNull(primary) {
                "Secondary context must wait for primary selection"
            }
            rejectFailedGeneration()
            require(generationId == currentPrimary.generationId) {
                "Secondary context belongs to another generation"
            }
            require(pageEntry in runningFiles.pageEntries) {
                "Unknown managed page entry"
            }
            require(parameters.keys.none(String::isEmpty)) {
                "Managed page parameter names must not be empty"
            }
            val logical = retainedStack().toMutableList()
            require(logical.size <= MAX_MANAGED_PAGES) {
                "Invalid managed logical stack size"
            }
            val page = LynxLogicalPage(pageEntry, parameters.toMap())
            if (reconstructing) {
                require(
                    store.value.optInt("reconstructionPosition", -1) ==
                        stackPosition,
                ) { "Reconstructed page is not the current stack position" }
                require(stackPosition in 1 until logical.size && logical[stackPosition] == page) {
                    "Reconstructed page does not match the retained stack"
                }
            } else {
                require(logical.size < MAX_MANAGED_PAGES) {
                    "Managed logical stack is full"
                }
                require(stackPosition == logical.size) {
                    "Managed page must be appended at the top of the stack"
                }
                logical.add(page)
            }
            require(!store.value.has("pageAttempt")) {
                "A secondary page admission is already pending"
            }
            SecondaryPlan(runningFiles, running, currentPrimary, logical, page)
        }
        val lease = installer.retain(plan.files)
        try {
            return synchronized(stateLock) {
                check(
                    !closed && primary === plan.primary &&
                        running == plan.receipt && runningFiles === plan.files,
                ) { "Primary selection changed during resource retention" }
                rejectFailedGeneration()
                val openingSourceContextId = sourceContextId ?: plan.primary.id
                val session = launchSession(
                    plan.files,
                    false,
                    plan.receipt.releaseId,
                    lease,
                    plan.page,
                    generationId,
                    openingSourceContextId,
                )
                mutate { next ->
                    next.put("logicalStack", stackJson(plan.stack))
                    next.put(
                        "pageAttempt",
                        JSONObject()
                            .put("attemptId", session.id)
                            .put("startupAttemptId", plan.primary.id)
                            .put("sourceContextId", openingSourceContextId)
                            .put("processId", currentProcessId())
                            .put("generationId", generationId)
                            .put("position", stackPosition)
                            .put("reconstructing", reconstructing)
                            .put("entry", plan.page.entry)
                            .put("parameters", JSONObject(plan.page.parameters))
                            .put("selection", plan.receipt.toJson())
                            .put(
                                "nativePageClass",
                                nativePageClass ?: JSONObject.NULL,
                            )
                            .put("fatal", false),
                    )
                }
                members.add(session)
                session
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
        page: LynxLogicalPage = LynxLogicalPage(files.entry),
        generationId: String = UUID.randomUUID().toString(),
        openingSourceContextId: String? = null,
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
            page.entry,
            page.parameters,
            generationId,
            openingSourceContextId,
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
                generationId = session.generationId,
                pageEntry = session.pageEntry,
                pageAttemptId = session.id.takeUnless { session.isPrimary },
            )
        }

    fun runtimeEvents(session: LynxLaunchSession): JSONObject =
        synchronized(stateLock) {
            requireLive(session, false)
            generationEventJournal.snapshot()
        }

    fun retainedLogicalStack(session: LynxLaunchSession): List<LynxLogicalPage> =
        synchronized(stateLock) {
            requireLive(session, false)
            retainedStack().map { it.copy(parameters = it.parameters.toMap()) }
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

    fun acceptManagedTransition(
        session: LynxLaunchSession,
        sourceGenerationId: String,
        stack: List<LynxLogicalPage>,
        trigger: String,
    ): JSONObject = synchronized(stateLock) {
        if (store.value.has("managedTransition")) {
            throw CatalogPolicy.Rejected(
                "TRANSITION_IN_PROGRESS",
                "A managed Lynx transition is already accepted",
            )
        }
        requireLive(session)
        rejectFailedGeneration()
        require(sourceGenerationId == session.generationId) {
            "Managed transition source generation is stale"
        }
        require(stack.isNotEmpty() && stack.size <= MAX_MANAGED_PAGES) {
            "Invalid managed transition stack size"
        }
        require(
            trigger == "reload" || trigger == "reset" ||
                trigger == "forcedActivation",
        ) {
            "Unsupported managed transition trigger"
        }
        require(stack == retainedStack()) {
            "Managed transition stack differs from the live native stack"
        }
        val targetReceipt = if (trigger == "reset") {
            builtin()
        } else {
            receipt("next") ?: running
        }
        val targetFiles = installed(targetReceipt)
        requireCompleteStack(targetFiles, stack)
        val transitionId = UUID.randomUUID().toString()
        val transition = JSONObject()
            .put("transitionId", transitionId)
            .put("trigger", trigger)
            .put("sourceGenerationId", sourceGenerationId)
            .put("source", running.toJson())
            .put("target", targetReceipt.toJson())
            .put("stack", stackJson(stack))
        mutate { next ->
            next.optJSONObject("pageAttempt")?.let { pageAttempt ->
                appendPageAttemptTerminal(
                    next = next,
                    attempt = pageAttempt,
                    terminal = "authorized-cancel",
                    stack = stack,
                    reason = "managedTransition",
                    transitionId = transitionId,
                    topContextId = liveTopContextId(
                        stackBeforeAttempt(stack, pageAttempt),
                        pageAttempt.getString("attemptId"),
                    ),
                )
            }
            if (trigger == "reset") {
                next.put("channel", configuration.channel)
                next.put("active", targetReceipt.toJson())
                next.remove("next")
                next.remove("confirmed")
                next.remove("launchTransition")
                next.remove("catalog")
                next.remove("catalogs")
            } else {
                next.put("next", targetReceipt.toJson())
            }
            next.remove("pending")
            next.remove("pageAttempt")
            next.remove("generationFailure")
            next.put("managedTransition", transition)
        }
        if (trigger == "reset") {
            runtimeChannel = configuration.channel
            accepted = null
            acceptedScopeSwitch = false
            preparations.values.forEach { preparation ->
                preparation.bytes?.let { bytes ->
                    runCatching { installer.discard(bytes) }
                }
            }
            preparations.clear()
            preparing.clear()
        }
        JSONObject()
            .put("status", "TRANSITION_ACCEPTED")
            .put("transitionId", transitionId)
    }

    private fun rejectFailedGeneration() {
        if (store.value.has("generationFailure")) {
            throw CatalogPolicy.Rejected(
                "STALE_CONTEXT",
                "The managed Lynx generation has already failed",
            )
        }
    }

    private fun currentProcessId(): String {
        val processId = processIdentity()
        check(processId.matches(Regex("^[1-9][0-9]*$"))) {
            "The managed Lynx process identity is invalid"
        }
        return processId
    }

    private fun activeManagedTransitionId(): String? = store.value
        .optJSONObject("managedTransition")
        ?.optString("transitionId")
        ?.takeIf(String::isNotEmpty)

    fun pendingManagedTransition(
        session: LynxLaunchSession,
    ): LynxManagedTransition? = synchronized(stateLock) {
        requireLive(session, false)
        store.value.optJSONObject("managedTransition")?.let { transition ->
            LynxManagedTransition(
                transitionId = transition.getString("transitionId"),
                trigger = transition.getString("trigger"),
                sourceGenerationId = transition.getString("sourceGenerationId"),
                stack = parseStack(transition.getJSONArray("stack")),
            )
        }
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
        val staged = try {
            synchronized(stateLock) { requireLive(session) }
            if (prepared.bytes != null) installer.commitPrepared(prepared.bytes) { publish ->
                synchronized(stateLock) { val authorization = authorize(session, prepared.guard, prepared.receipt); publish().also { publishSelection(authorization, it) } }
            } else synchronized(stateLock) { val authorization = authorize(session, prepared.guard, prepared.receipt); publishSelection(authorization) }
            checkNotNull(result)
        } finally {
            prepared.bytes?.let(installer::discard)
        }
        session.scope.launch(Dispatchers.IO) { pruneUnused() }
        return staged
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
        val acceptedSourceGeneration = store.value
            .optJSONObject("managedTransition")
            ?.optString("sourceGenerationId")
            ?.takeIf(String::isNotEmpty)
        if (
            closed || !session.live || session.failed ||
            session.controller !== this || session !in members ||
            (primaryOnly && session !== primary) ||
            acceptedSourceGeneration == session.generationId
        ) throw CatalogPolicy.Rejected("STALE_CONTEXT", "The calling native context is not eligible")
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
        val previous = store.value.optJSONObject("launchTransition")
        val inheritedTransitionId = previous?.let {
            validateStoredLaunchTransition(it)
            val previousFrom = CatalogPolicy.parseReceipt(it.getJSONObject("from"))
            val previousTo = CatalogPolicy.parseReceipt(it.getJSONObject("to"))
            val sameTransition = it.getString("kind") == kind &&
                previousFrom == from && previousTo == to
            val reversesInterruptedTransition = recovery && previousTo == from
            if (sameTransition || reversesInterruptedTransition) {
                transitionId(it)
            } else {
                null
            }
        }
        return JSONObject()
            .put("kind", kind)
            .put("from", from.toJson())
            .put("to", to.toJson())
            .put(
                "transitionId",
                store.value.optJSONObject("managedTransition")
                    ?.let(::transitionId)
                    ?: inheritedTransitionId
                    ?: UUID.randomUUID().toString(),
            )
    }

    private fun transitionId(value: JSONObject): String {
        val transitionId = value.opt("transitionId") as? String
        check(transitionId != null && isCanonicalTransitionId(transitionId)) {
            "Transition identifier is invalid"
        }
        return transitionId
    }

    private fun isCanonicalTransitionId(value: String): Boolean = runCatching {
        UUID.fromString(value).toString().equals(value, ignoreCase = true)
    }.getOrDefault(false)

    private fun validateStoredLaunchTransition(value: JSONObject) {
        val kind = value.getString("kind")
        val from = CatalogPolicy.parseReceipt(value.getJSONObject("from"))
        val to = CatalogPolicy.parseReceipt(value.getJSONObject("to"))
        check(!sameRelease(from, to)) {
            "Launch transition identity did not change"
        }
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
    }

    private fun normalizeStoredLaunchTransition() {
        val managedTransition = store.value.optJSONObject("managedTransition")
        val managedTransitionId = managedTransition?.let(::transitionId)
        val launchTransition = store.value.optJSONObject("launchTransition")
            ?: return
        validateStoredLaunchTransition(launchTransition)
        val launchTransitionId = if (launchTransition.has("transitionId")) {
            transitionId(launchTransition)
        } else {
            managedTransitionId ?: UUID.randomUUID().toString()
        }
        check(
            managedTransitionId == null || managedTransitionId == launchTransitionId,
        ) { "Launch and managed transition identifiers do not match" }
        if (!launchTransition.has("transitionId")) {
            mutate {
                it.getJSONObject("launchTransition")
                    .put("transitionId", launchTransitionId)
            }
        }
    }

    private fun transitionResponse(value: JSONObject?): Any {
        if (value == null) return JSONObject.NULL
        validateStoredLaunchTransition(value)
        val kind = value.getString("kind")
        val from = CatalogPolicy.parseReceipt(value.getJSONObject("from"))
        val to = CatalogPolicy.parseReceipt(value.getJSONObject("to"))
        check(to == running) { "Launch transition target is not running" }
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
        check(!store.value.has("pageAttempt")) {
            "A secondary page is still awaiting admission"
        }
        val transition = store.value.optJSONObject("launchTransition")
        val managedTransitionId = store.value.optJSONObject("managedTransition")
            ?.let(::transitionId)
        val launchTransitionId = transition?.let(::transitionId)
        check(
            managedTransitionId == null || launchTransitionId == null ||
                managedTransitionId == launchTransitionId,
        ) { "Launch and managed transition identifiers do not match" }
        val pending = store.value.optJSONObject("pending")
        if (runningConfirmed) {
            if (pending != null) {
                check(
                    pending.optString("attemptId") == session.id &&
                        !pending.optBoolean("fatal") &&
                        CatalogPolicy.parseReceipt(
                            pending.getJSONObject("selection"),
                        ) == running &&
                        (pending.opt("transitionId") as? String) == managedTransitionId,
                ) { "Startup attempt cannot be confirmed" }
            } else {
                check(managedTransitionId == null) {
                    "No pending managed startup attempt"
                }
            }
            if (
                pending != null || transition != null ||
                store.value.has("managedTransition")
            ) {
                mutate {
                    it.remove("pending")
                    it.remove("launchTransition")
                    it.remove("managedTransition")
                }
            }
            return JSONObject()
                .put("status", "ALREADY_CONFIRMED")
                .put("transitionId", launchTransitionId ?: JSONObject.NULL)
                .put("transition", transitionResponse(transition))
        }
        check(pending?.optString("attemptId") == session.id && !pending.optBoolean("fatal")) { "Startup attempt cannot be confirmed" }
        check(eligible(running)) { "Running selection is excluded" }
        mutate {
            it.remove("pending")
            it.put("confirmed", running.toJson())
            it.remove("launchTransition")
            it.remove("managedTransition")
        }
        runningConfirmed = true
        Log.i(TAG, "confirmed bundle=${running.bundleId} release=${running.releaseId} attempt=${session.id}")
        JSONObject()
            .put("status", "CONFIRMED")
            .put("transitionId", launchTransitionId ?: JSONObject.NULL)
            .put("transition", transitionResponse(transition))
    }

    internal fun primaryAdmissionReady(session: LynxLaunchSession): Boolean =
        synchronized(stateLock) {
            requireLive(session)
            !store.value.has("pageAttempt") &&
                !store.value.has("reconstructionPosition") &&
                !store.value.has("generationFailure")
        }

    internal fun admitSecondary(
        session: LynxLaunchSession,
        deferPrimaryFlush: Boolean = false,
    ): JSONObject {
        val primaryToFlush = synchronized(stateLock) {
            requireLive(session, false)
            check(!session.isPrimary && session.firstScreen && !session.failed) {
                "Secondary page content is not ready"
            }
            val attempt = store.value.optJSONObject("pageAttempt")
            if (attempt == null) {
                val terminal = store.value.optJSONObject("lastPageAttempt")
                check(
                    terminal?.optString("attemptId") == session.id &&
                        terminal.optString("generationId") == session.generationId &&
                        terminal.optString("entry") == session.pageEntry &&
                        terminal.optString("terminal") == "admitted",
                ) { "Secondary page has no pending admission" }
                return@synchronized null
            }
            check(
                attempt.optString("attemptId") == session.id &&
                    attempt.optString("generationId") == session.generationId &&
                    attempt.optString("entry") == session.pageEntry,
            ) { "Secondary page admission authority is stale" }
            mutate { next ->
                appendPageAttemptTerminal(
                    next = next,
                    attempt = attempt,
                    terminal = "admitted",
                    stack = retainedStack(),
                    transitionId = activeManagedTransitionId(),
                    topContextId = session.id,
                )
                next.remove("pageAttempt")
                if (attempt.optBoolean("reconstructing")) {
                    val nextPosition = attempt.getInt("position") + 1
                    if (nextPosition < retainedStack().size) {
                        next.put("reconstructionPosition", nextPosition)
                    } else {
                        next.remove("reconstructionPosition")
                    }
                }
            }
            primary
        }
        if (!deferPrimaryFlush) primaryToFlush?.flushReady()
        return JSONObject()
            .put("status", "PAGE_ADMITTED")
            .put("pageAttemptId", session.id)
    }

    fun cancelSecondary(
        session: LynxLaunchSession,
        reason: LynxPageCancelReason,
    ): Boolean = cancelSecondary(session, reason, deferPrimaryFlush = false)

    @JvmSynthetic
    fun cancelSecondaryForHost(
        session: LynxLaunchSession,
        reason: LynxPageCancelReason,
    ): Boolean = cancelSecondary(session, reason, deferPrimaryFlush = true)

    private fun cancelSecondary(
        session: LynxLaunchSession,
        reason: LynxPageCancelReason,
        deferPrimaryFlush: Boolean,
    ): Boolean {
        val primaryToFlush = synchronized(stateLock) {
            requireLive(session, false)
            check(!session.isPrimary) { "The primary page cannot be popped" }
            val stack = retainedStack().toMutableList()
            val attempt = store.value.optJSONObject("pageAttempt")
            if (attempt != null) {
                check(attempt.optString("attemptId") == session.id) {
                    "Another page admission is pending"
                }
                val position = attempt.getInt("position")
                check(
                    position in 1 until stack.size &&
                        stack[position] == LynxLogicalPage(
                            session.pageEntry,
                            session.pageParameters,
                        ),
                ) { "Only the live top page can be popped" }
                while (stack.size > position) stack.removeAt(stack.lastIndex)
            } else {
                check(stack.size > 1 && stack.last() == LynxLogicalPage(
                    session.pageEntry,
                    session.pageParameters,
                )) { "Only the live top page can be popped" }
                stack.removeAt(stack.lastIndex)
            }
            mutate { next ->
                if (attempt != null) {
                    appendPageAttemptTerminal(
                        next = next,
                        attempt = attempt,
                        terminal = "authorized-cancel",
                        stack = stack,
                        reason = reason.wireValue,
                        topContextId = liveTopContextId(stack, session.id),
                    )
                    next.remove("pageAttempt")
                }
                next.remove("reconstructionPosition")
                next.put("logicalStack", stackJson(stack))
            }
            primary
        }
        if (!deferPrimaryFlush) primaryToFlush?.flushReady()
        return true
    }

    @JvmSynthetic
    fun flushPrimaryReadinessAfterHostEvent() {
        val primaryToFlush = synchronized(stateLock) { primary }
        primaryToFlush?.flushReady()
    }

    fun rollbackSecondary(session: LynxLaunchSession): Boolean =
        synchronized(stateLock) {
            requireLive(session, false)
            check(!session.isPrimary) { "The primary page cannot be rolled back" }
            val attempt = store.value.optJSONObject("pageAttempt")
                ?: return@synchronized false
            if (attempt.optString("attemptId") != session.id) {
                return@synchronized false
            }
            val stack = retainedStack().toMutableList()
            val position = attempt.getInt("position")
            check(
                position in 1 until stack.size &&
                    stack[position] == LynxLogicalPage(
                        session.pageEntry,
                        session.pageParameters,
                    ),
            ) { "Only the unlaunched top page can be rolled back" }
            mutate { next ->
                next.remove("pageAttempt")
                if (attempt.optBoolean("reconstructing")) {
                    next.put("reconstructionPosition", position)
                } else {
                    stack.removeAt(stack.lastIndex)
                    next.remove("reconstructionPosition")
                    next.put("logicalStack", stackJson(stack))
                }
            }
            true
        }
    internal fun fail(
        session: LynxLaunchSession,
        message: String,
        allowConfirmed: Boolean = false,
        failureCode: Int? = null,
        failureResourcePath: String? = null,
    ): Boolean {
        return synchronized(stateLock) {
            val pending = store.value.optJSONObject("pending")
            val managedStartupPending = pending?.opt("transitionId") is String
            if (
                closed || session !in members || !session.live ||
                session.isPrimary && session !== primary ||
                session.isPrimary && runningConfirmed && !allowConfirmed &&
                !managedStartupPending
            ) return@synchronized false
            if (session.failed) return@synchronized false
            val pageAttempt = store.value.optJSONObject("pageAttempt")
            if (!session.isPrimary && (
                pageAttempt == null ||
                    pageAttempt.optString("attemptId") != session.id ||
                    pageAttempt.optString("generationId") != session.generationId
            )) {
                return@synchronized false
            }
            if (session.isPrimary && (!runningConfirmed || managedStartupPending) &&
                pending?.optString("attemptId") != session.id) {
                return@synchronized false
            }
            if (
                session.isPrimary && pending?.optBoolean("fatal") == true ||
                !session.isPrimary && pageAttempt?.optBoolean("fatal") == true
            ) {
                session.failed = true
                return@synchronized false
            }
            mutate { next ->
                if (session.isPrimary && pending != null) {
                    next.put("pending", JSONObject(pending.toString()).put("fatal", true).put("message", message))
                }
                if (!session.isPrimary && pageAttempt != null) {
                    appendPageAttemptTerminal(
                        next = next,
                        attempt = pageAttempt,
                        terminal = "verified-fatal",
                        stack = retainedStack(),
                        transitionId = activeManagedTransitionId(),
                        topContextId = liveTopContextId(
                            stackBeforeAttempt(
                                retainedStack(),
                                pageAttempt,
                            ),
                            session.id,
                        ),
                        message = message,
                        failureCode = failureCode,
                        failureResourcePath = failureResourcePath,
                    )
                    next.remove("pageAttempt")
                }
                if (runningConfirmed || !session.isPrimary) {
                    next.put(
                        "generationFailure",
                        JSONObject()
                            .put("selection", running.toJson())
                            .put("fatal", true)
                            .put("message", message)
                            .put("pageAttemptId", session.id)
                            .put("pageEntry", session.pageEntry),
                    )
                }
                if (running.bundleId != embedded.bundleId) {
                    val crashed = exclusions("crashed").toMutableList()
                    crashed.removeAll { it == running.bundleId }
                    crashed.add(running.bundleId)
                    while (crashed.size > 10) crashed.removeAt(0)
                    next.put("crashed", JSONArray(crashed))
                }
                if (running.releaseId != null) {
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
            members.remove(session)
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
            members.forEach { it.live = false }
            members.clear()
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
    companion object {
        private const val TAG = "HotUpdaterLynx"
        private const val CAPACITY = 128
        private const val MAX_MANAGED_PAGES = 16
        private const val PAGE_ATTEMPT_TERMINAL_CAPACITY = 256
    }
}
