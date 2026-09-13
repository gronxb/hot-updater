package com.hotupdater.lynx

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.lynx.tasm.LynxBooleanOption
import com.lynx.tasm.LynxError
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.LynxViewClient
import com.lynx.tasm.provider.AbsTemplateProvider
import java.io.File
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
) {
    private val closed = AtomicBoolean()
    @Volatile internal var live = true
    @Volatile internal var failed = false
    internal var firstScreen = false
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val ready = mutableListOf<(Result<JSONObject>) -> Unit>()
    private val bridgeReplies = LynxBridgeReplies()
    private var context: Context? = null
    private val requiredResources = mutableSetOf<String>()
    private val loadedResources = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private var reloadHandler: (((Result<Unit>) -> Unit) -> Unit)? = null
    private var failureHandler: ((String) -> Unit)? = null
    private var firstContentHandler: (() -> Unit)? = null
    private var confirmedHandler: ((JSONObject) -> Unit)? = null
    val resources = LynxReleaseResources(
        installation.directory,
        installation.bundleId,
        installation.managedFileHashes,
        snapshotDirectory,
    )
    val entryUrl = "hot-updater:///" + installation.entry
    init {
        resources.isLive = { live }
        resources.onFailure = ::notifyFailure
    }
    private fun notifyFailure(message: String) {
        runCatching { controller.fail(this, message) }
        handler.post {
            failureHandler?.invoke(message)
            flushReady()
        }
    }
    /** Native app readiness may require verified resources to complete before confirmation. */
    fun requireResourceBeforeReady(path: String) {
        check(context == null && path in installation.managedPaths) { "Declare a verified resource before binding the context" }
        requiredResources.add(path)
    }
    /** Installed by a packaged host that can replace the complete Lynx generation. */
    fun setReloadHandler(handler: ((Result<Unit>) -> Unit) -> Unit) {
        check(live && reloadHandler == null) { "Reload handler is already configured" }
        reloadHandler = handler
    }
    /** Installed by a packaged host that can reconstruct a failed generation. */
    fun setFailureHandler(handler: (String) -> Unit) {
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
        if (isPrimary) confirmedHandler = confirmed
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
    internal fun reloadAction(): ((Result<Unit>) -> Unit) -> Unit {
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
    /** Configure every resource boundary before constructing the view. */
    fun configure(
        builder: LynxViewBuilder,
        unmanagedGeneric: com.lynx.tasm.resourceprovider.generic.LynxGenericResourceFetcher? = null,
        unmanagedTemplate: com.lynx.tasm.resourceprovider.template.LynxTemplateResourceFetcher? = null,
    ) {
        check(live)
        resources.unmanagedGeneric = unmanagedGeneric
        resources.unmanagedTemplate = unmanagedTemplate
        builder.setTemplateProvider(object : AbsTemplateProvider() {
            override fun loadTemplate(uri: String, callback: Callback) {
                try {
                    check(live)
                    resources.loadBytes(uri, callback::onSuccess)
                }
                catch (error: Exception) {
                    notifyFailure(error.message ?: "Template failure")
                    callback.onFailed(error.message)
                }
            }
        })
        builder.setMediaResourceFetcher(resources.media)
        builder.setFontLoader(resources.font)
        builder.setGenericResourceFetcher(resources.generic)
        builder.setTemplateResourceFetcher(resources.template)
        builder.setEnableGenericResourceFetcher(LynxBooleanOption.TRUE)
    }
    /** Bind before load/evaluation so module construction sees the exact native context. */
    fun bind(view: LynxView) {
        check(context == null && live)
        context = view.lynxContext
        HotUpdaterLynxModule.bind(view.lynxContext, this)
        view.addLynxViewClient(object : LynxViewClient() {
            override fun onFirstScreen() { handler.post {
                if (live) {
                    val first = !firstScreen
                    firstScreen = true
                    if (first) firstContentHandler?.invoke()
                    flushReady()
                }
            } }
            override fun onReceivedError(error: LynxError) {
                android.util.Log.i("HotUpdaterLynx", "engine-error fatal=${error.isFatal} code=${error.errorCode} message=${error.msg}")
                if (error.isFatal) {
                    notifyFailure(error.msg)
                }
            }
            override fun onLoadFailed(message: String) {
                notifyFailure(message)
            }
        })
    }
    internal fun notifyReady(callback: (Result<JSONObject>) -> Unit) {
        if (!live || !isPrimary || failed) { callback(Result.failure(CatalogPolicy.Rejected("STALE_CONTEXT", "Context cannot confirm startup"))); return }
        ready.add(callback); flushReady()
    }
    private fun flushReady() {
        if (ready.isEmpty()) return
        if (live && !failed && (!firstScreen || !loadedResources.containsAll(requiredResources))) return
        val callbacks = ready.toList().also { ready.clear() }
        callbacks.forEachIndexed { index, callback ->
            val confirmation = runCatching { controller.confirm(this) }
            if (index == 0) {
                confirmation.getOrNull()?.let { confirmedHandler?.invoke(it) }
            }
            callback(confirmation)
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
        resources.onFailure = null
        resources.onLoaded = null
        resources.resourceGate = null
    }
}
