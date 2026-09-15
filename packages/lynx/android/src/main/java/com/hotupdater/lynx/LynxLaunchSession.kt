package com.hotupdater.lynx

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.lynx.tasm.LynxError
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.LynxViewClient
import java.io.File
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject

/** One actual native context; the session is never supplied by downloaded JS. */
class LynxLaunchSession internal constructor(
    internal val controller: LynxUpdaterController,
    val installation: VerifiedLynxInstallation,
    internal val id: String,
    val isPrimary: Boolean,
    internal val launchReleaseId: String?,
    snapshotDirectory: File = File(
        installation.directory.parentFile,
        ".hot-updater-resource-$id",
    ),
    private val installationLease: InstallationLease = InstallationLease.none,
    val pageEntry: String = installation.entry,
    val pageParameters: Map<String, String> = emptyMap(),
    val generationId: String = "legacy",
    val openingSourceContextId: String? = null,
) {
    private val closed = AtomicBoolean()
    @Volatile internal var live = true
    @Volatile internal var failed = false
    internal var firstScreen = false
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val ready = mutableListOf<(Result<JSONObject>) -> Unit>()
    private var secondaryAdmission: JSONObject? = null
    private var bridgeReplies = LynxBridgeReplies()
    private var context: Context? = null
    private var bindingEpoch = 0L
    private val requiredResources = mutableSetOf<String>()
    private val loadedResources = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private var reloadHandler:
        ((String, (Result<JSONObject>) -> Unit) -> Unit)? = null
    private var failureHandler: ((String, Int?, String?) -> Unit)? = null
    private var firstContentHandler: (() -> Unit)? = null
    private var confirmedHandler: ((JSONObject) -> Unit)? = null
    private var engineDiagnosticHandler: ((Map<String, Any?>) -> Unit)? = null
    private var readinessGate: (() -> Boolean)? = null
    val resources = LynxReleaseResources(
        installation.directory,
        installation.bundleId,
        installation.managedFileHashes,
        snapshotDirectory,
    )
    val entryUrl = "hot-updater:///" + pageEntry
    init {
        resources.isLive = { live }
        resources.onFailure = { message -> notifyFailure(message) }
    }
    private fun notifyFailure(
        message: String,
        failureCode: Int? = null,
        failureResourcePath: String? = null,
    ) {
        val accepted = runCatching {
            controller.fail(
                this,
                message,
                failureCode = failureCode,
                failureResourcePath = failureResourcePath,
            )
        }
            .getOrDefault(false)
        handler.post {
            if (accepted) {
                failureHandler?.invoke(
                    message,
                    failureCode,
                    failureResourcePath,
                )
            }
            flushReady()
        }
    }
    /** Native app readiness may require verified resources to complete before confirmation. */
    fun requireResourceBeforeReady(path: String) {
        check(context == null && path in installation.managedPaths) { "Declare a verified resource before binding the context" }
        requiredResources.add(path)
    }
    /** Installed by a packaged host that can replace the complete Lynx generation. */
    fun setReloadHandler(
        handler: (String, (Result<JSONObject>) -> Unit) -> Unit,
    ) {
        check(live && reloadHandler == null) { "Reload handler is already configured" }
        reloadHandler = handler
    }
    /** Installed by a packaged host that can reconstruct a failed generation. */
    fun setFailureHandler(handler: (String, Int?, String?) -> Unit) {
        check(live && failureHandler == null) { "Failure handler is already configured" }
        failureHandler = handler
    }
    /** Optional diagnostics emitted from actual engine and confirmation callbacks. */
    fun setReadinessHandlers(
        firstContent: () -> Unit,
        confirmed: (JSONObject) -> Unit,
    ) {
        check(live && firstContentHandler == null && confirmedHandler == null)
        firstContentHandler = firstContent
        confirmedHandler = confirmed
    }
    /** Records an engine diagnostic against this exact managed context. */
    fun setEngineDiagnosticHandler(handler: (Map<String, Any?>) -> Unit) {
        check(live && engineDiagnosticHandler == null)
        engineDiagnosticHandler = handler
    }
    /** Adds host-owned readiness state without inventing a managed resource path. */
    fun setReadinessGate(gate: () -> Boolean) {
        check(live && context == null && readinessGate == null)
        readinessGate = gate
    }
    /** Serializes complete verified loads with generation retirement. */
    fun setResourceGate(gate: ((() -> Unit)) -> Unit) {
        check(live && resources.resourceGate == null)
        resources.resourceGate = gate
    }
    /** Observes verified managed resources without exposing filesystem authority. */
    fun setResourceObserver(observer: (event: String, path: String, sha256: String) -> Unit) {
        check(live && resources.onLoaded == null)
        resources.onLoaded = { event, path, sha256 ->
            observer(event, path, sha256)
            loadedResources.add(path)
            handler.post { flushReady() }
        }
    }
    internal fun reloadAction():
        (String, (Result<JSONObject>) -> Unit) -> Unit {
        check(live && isPrimary) { "Only the live primary context can reload" }
        return checkNotNull(reloadHandler) {
            "The native host does not support managed Lynx generation reload"
        }
    }
    internal fun beginBridgeReply(
        callback: (Result<JSONObject>) -> Unit,
    ): LynxBridgeReplies.Ticket? = bridgeReplies.register(callback)

    internal fun finishBridgeReply(
        ticket: LynxBridgeReplies.Ticket,
        result: Result<JSONObject>,
    ) = bridgeReplies.settle(ticket, result)
    /** Records a fatal member failure through the generation's primary authority. */
    fun recordGenerationFailure(message: String): Boolean {
        check(live && isPrimary)
        return controller.fail(this, message, allowConfirmed = true)
    }
    /** Records a fatal failure for this exact live generation member. */
    fun recordFatalFailure(message: String): Boolean {
        check(live)
        return controller.fail(this, message, allowConfirmed = true)
    }
    /** Configure every resource boundary before constructing the view. */
    fun configure(
        builder: LynxViewBuilder,
        unmanagedGeneric: com.lynx.tasm.resourceprovider.generic.LynxGenericResourceFetcher? = null,
        unmanagedTemplate: com.lynx.tasm.resourceprovider.template.LynxTemplateResourceFetcher? = null,
    ) {
        check(live)
        resources.unmanagedGeneric = unmanagedGeneric
        resources.unmanagedTemplate = unmanagedTemplate
        resources.configure(builder)
    }
    /** Bind before load/evaluation so module construction sees the exact native context. */
    fun bind(
        view: LynxView,
        launchConfiguration: Map<String, String> = emptyMap(),
    ) {
        check(context == null && live)
        val epoch = ++bindingEpoch
        context = view.lynxContext
        resources.bindImageContext(view.lynxContext)
        HotUpdaterLynxModule.bind(
            view.lynxContext,
            this,
            launchConfiguration,
        )
        view.addLynxViewClient(object : LynxViewClient() {
            override fun onFirstScreen() { handler.post {
                if (live && epoch == bindingEpoch) {
                    val first = !firstScreen
                    firstScreen = true
                    if (first) firstContentHandler?.invoke()
                    flushReady()
                }
            } }
            override fun onReceivedError(error: LynxError) {
                android.util.Log.i("HotUpdaterLynx", "engine-error fatal=${error.isFatal} code=${error.errorCode} message=${error.msg}")
                if (epoch == bindingEpoch) {
                    managedEngineDiagnostic(
                        error.isFatal,
                        error.errorCode,
                        error.msg,
                        installation.managedPaths,
                    )?.let { engineDiagnosticHandler?.invoke(it) }
                    if (error.isFatal) {
                        notifyFailure(error.msg, error.errorCode)
                    }
                }
            }
            override fun onLoadFailed(message: String) {
                if (epoch == bindingEpoch) notifyFailure(message)
            }
        })
    }
    fun prepareForRebind(): Context? {
        check(live && context != null)
        bindingEpoch += 1
        val previous = context
        previous?.let(HotUpdaterLynxModule::unbind)
        context = null
        ready.clear()
        firstScreen = false
        loadedResources.clear()
        bridgeReplies.close()
        bridgeReplies = LynxBridgeReplies()
        resources.prepareForRebind()
        reloadHandler = null
        firstContentHandler = null
        confirmedHandler = null
        engineDiagnosticHandler = null
        resources.onFailure = { message -> notifyFailure(message) }
        return previous
    }
    internal fun notifyReady(callback: (Result<JSONObject>) -> Unit) {
        if (!live || failed) { callback(Result.failure(CatalogPolicy.Rejected("STALE_CONTEXT", "Context cannot confirm startup"))); return }
        secondaryAdmission?.let {
            callback(Result.success(JSONObject(it.toString())))
            return
        }
        ready.add(callback); flushReady()
    }
    internal fun flushReady() {
        if (ready.isEmpty()) return
        if (
            live && !failed && (
                !firstScreen || !loadedResources.containsAll(requiredResources) ||
                    readinessGate?.invoke() == false
            )
        ) return
        if (isPrimary && live && !failed && !controller.primaryAdmissionReady(this)) {
            return
        }
        val callbacks = ready.toList().also { ready.clear() }
        val confirmation = runCatching {
            if (isPrimary) controller.confirm(this)
            else controller.admitSecondary(
                this,
                deferPrimaryFlush = true,
            ).also {
                secondaryAdmission = JSONObject(it.toString())
            }
        }
        try {
            confirmation.getOrNull()?.let { confirmedHandler?.invoke(it) }
            callbacks.forEach { callback -> callback(confirmation) }
        } finally {
            if (!isPrimary && confirmation.isSuccess) {
                controller.flushPrimaryReadinessAfterHostEvent()
            }
        }
    }
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        live = false
        ready.clear()
        bridgeReplies.close()
        resources.close()
        installationLease.close()
        controller.destroy(this)
        context?.let(HotUpdaterLynxModule::unbind)
        scope.cancel()
        reloadHandler = null
        failureHandler = null
        firstContentHandler = null
        confirmedHandler = null
        engineDiagnosticHandler = null
        readinessGate = null
        resources.onFailure = null
        resources.onLoaded = null
        resources.resourceGate = null
    }
}

internal fun managedEngineDiagnostic(
    fatal: Boolean,
    code: Int,
    message: String,
    managedPaths: Set<String>,
): Map<String, Any?>? {
    val payload = runCatching { JSONObject(message) }.getOrNull() ?: return null
    if (payload.opt("error_code") != code) return null
    val subcode = payload.opt("sub_code") as? Int ?: return null
    val type = payload.opt("type") as? String ?: return null
    if (type.isEmpty()) return null
    val source = payload.opt("src") as? String ?: return null
    if (!source.startsWith("hot-updater:///")) return null
    val uri = runCatching { URI(source) }.getOrNull() ?: return null
    if (
        uri.scheme != "hot-updater" ||
        !uri.authority.isNullOrEmpty() ||
        uri.query != null ||
        uri.fragment != null
    ) return null
    val path = uri.path?.removePrefix("/") ?: return null
    val canonical = runCatching {
        com.hotupdater.lynx.internal.ManagedPaths.normalize(path)
    }.getOrNull() ?: return null
    if (
        canonical != path ||
        source != "hot-updater:///$path" ||
        path !in managedPaths
    ) return null
    return linkedMapOf(
        "fatal" to fatal,
        "code" to code,
        "subcode" to subcode,
        "type" to type,
        "path" to path,
    )
}
