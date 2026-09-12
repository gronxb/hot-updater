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
) {
    @Volatile internal var live = true
    @Volatile internal var failed = false
    internal var firstScreen = false
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val ready = mutableListOf<(Result<JSONObject>) -> Unit>()
    private var context: Context? = null
    private val requiredFonts = mutableSetOf<String>()
    val resources = LynxReleaseResources(installation.directory, installation.bundleId, installation.managedPaths)
    val entryUrl = "hot-updater:///" + installation.entry
    init {
        resources.isLive = { live }
        resources.onFailure = { message -> controller.fail(this, message); handler.post { flushReady() } }
        resources.onFontLoaded = { handler.post { flushReady() } }
    }
    /** Native app readiness may require a particular font to be decoded before confirmation. */
    fun requireFontBeforeReady(path: String) {
        check(context == null && path in installation.managedPaths) { "Declare a verified font before binding the context" }
        requiredFonts.add(path)
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
                try { check(live); callback.onSuccess(resources.resolve(uri).readBytes()) }
                catch (error: Exception) { controller.fail(this@LynxLaunchSession, error.message ?: "Template failure"); callback.onFailed(error.message) }
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
            override fun onFirstScreen() { handler.post { if (live) { firstScreen = true; flushReady() } } }
            override fun onReceivedError(error: LynxError) {
                android.util.Log.i("HotUpdaterLynx", "engine-error fatal=${error.isFatal} code=${error.errorCode} message=${error.msg}")
                if (error.isFatal || !firstScreen) {
                    controller.fail(this@LynxLaunchSession, error.msg)
                    handler.post { flushReady() }
                }
            }
            override fun onLoadFailed(message: String) { controller.fail(this@LynxLaunchSession, message); handler.post { flushReady() } }
        })
    }
    internal fun notifyReady(callback: (Result<JSONObject>) -> Unit) {
        if (!live || !isPrimary || failed) { callback(Result.failure(CatalogPolicy.Rejected("STALE_CONTEXT", "Context cannot confirm startup"))); return }
        ready.add(callback); flushReady()
    }
    private fun flushReady() {
        if (ready.isEmpty()) return
        if (live && !failed && (!firstScreen || !resources.loadedFonts.containsAll(requiredFonts))) return
        val result = runCatching { JSONObject().put("status", controller.confirm(this)) }
        ready.toList().also { ready.clear() }.forEach { it(result) }
    }
    fun close() {
        if (!live) return
        controller.destroy(this)
        context?.let(HotUpdaterLynxModule::unbind)
        scope.cancel()
        ready.clear()
    }
}
