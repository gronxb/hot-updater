package com.hotupdaterexample.brownfield

import android.app.Activity
import android.app.Application
import android.content.Context
import android.view.View
import com.facebook.react.PackageList
import com.facebook.react.ReactHost
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.defaults.DefaultComponentsRegistry
import com.facebook.react.defaults.DefaultReactHostDelegate
import com.facebook.react.defaults.DefaultTurboModuleManagerDelegate
import com.facebook.react.fabric.ComponentFactory
import com.facebook.react.interfaces.fabric.ReactSurface
import com.facebook.react.runtime.ReactHostImpl
import com.facebook.react.runtime.hermes.HermesInstance
import com.hotupdater.HotUpdater
import com.hotupdater.HotUpdaterInstance
import com.hotupdater.HotUpdaterOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The E2E host's second Hot Updater instance, `widget`: a React Native runtime
 * of its own beside the example's, with its own embedded bundle
 * (`widget.android.bundle`, from `index.widget.js`) on its own channel. Its
 * bundles, crash history, and recovery stay apart from the example's.
 *
 * Like the example's start, it checks for its update natively before its
 * runtime starts and reports the status as `widgetNativeCheckResult`; its
 * JavaScript only calls `HotUpdater.init`. React Native Brownfield runs one
 * React host, and `getDefaultReactHost` keeps one per process, so this one
 * builds its host itself. A scenario turns it on; every other scenario runs
 * the example alone.
 */
object HotUpdaterWidgetHost {
    private const val MODULE_NAME = "HotUpdaterWidget"
    private const val BUNDLE_ASSET_NAME = "widget.android.bundle"

    // Outlives every activity, so closing a screen never cancels the check.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var reactHost: ReactHost? = null
    private var surface: ReactSurface? = null

    /** Whether a scenario turned the widget on, so the host leaves room for it. */
    fun isEnabled(context: Context): Boolean = readRequest(context) != null

    /**
     * Hands [onView] the widget's React Native root for [activity] on the main
     * thread, or null when it is off. Call it once the example's bundle has
     * loaded, as the iOS host does.
     */
    fun createView(
        activity: Activity,
        onView: (View?) -> Unit,
    ) {
        surface?.let { return onView(it.view) }
        val request = readRequest(activity) ?: return onView(null)
        val application = activity.application
        scope.launch {
            val host =
                reactHost ?: run {
                    val widget = createInstance(application, request) ?: return@launch onView(null)
                    request.report(ReactNativeHostManager.checkForUpdate(widget, request), field = "widgetNativeCheckResult")
                    // Another call may have created it while this one checked.
                    reactHost ?: createReactHost(application, widget).also { reactHost = it }
                }
            if (activity.isFinishing || activity.isDestroyed) return@launch onView(null)
            surface?.let { return@launch onView(it.view) }
            host.onHostResume(activity)
            val created = host.createSurface(activity, MODULE_NAME, null)
            created.start()
            surface = created
            onView(created.view)
        }
    }

    fun onResume(activity: Activity) {
        if (surface != null) reactHost?.onHostResume(activity)
    }

    fun onPause(activity: Activity) {
        if (surface != null) reactHost?.onHostPause(activity)
    }

    /** The surface belongs to [activity]; the host lives on for the next one. */
    fun onDestroy(activity: Activity) {
        val current = surface ?: return
        current.stop()
        current.detach()
        surface = null
        reactHost?.onHostDestroy(activity)
    }

    private fun readRequest(context: Context) = NativeUpdateCheckRequest.read(context, NativeUpdateCheckRequest.WIDGET_KEY)

    /**
     * Its own name keeps its state apart; channel and embedded bundle are the
     * widget's, while the fingerprint and signing key are the app's.
     */
    private fun createInstance(
        application: Application,
        request: NativeUpdateCheckRequest,
    ): HotUpdaterInstance? =
        runCatching {
            HotUpdater.init(
                application,
                HotUpdaterOptions(
                    baseURL = request.baseURL,
                    requestTimeoutMillis = request.requestTimeoutMillis,
                    name = "widget",
                    channel = "widget",
                    bundleAssetName = BUNDLE_ASSET_NAME,
                ),
            )
        }.getOrNull()

    /** Starts with the bundle the widget's instance picks, after its check. */
    @OptIn(UnstableReactNativeAPI::class)
    private fun createReactHost(
        application: Application,
        widget: HotUpdaterInstance,
    ): ReactHost {
        val bundleFile = widget.getJSBundleFile()
        val bundleLoader =
            if (bundleFile.startsWith("assets://")) {
                JSBundleLoader.createAssetLoader(application, bundleFile, true)
            } else {
                JSBundleLoader.createFileLoader(bundleFile)
            }
        val delegate =
            DefaultReactHostDelegate(
                jsMainModulePath = "index.widget",
                jsBundleLoader = bundleLoader,
                reactPackages = PackageList(application).packages,
                jsRuntimeFactory = HermesInstance(),
                turboModuleManagerDelegateBuilder = DefaultTurboModuleManagerDelegate.Builder(),
            )
        val componentFactory = ComponentFactory()
        DefaultComponentsRegistry.register(componentFactory)
        return ReactHostImpl(application, delegate, componentFactory, false, false)
    }
}
