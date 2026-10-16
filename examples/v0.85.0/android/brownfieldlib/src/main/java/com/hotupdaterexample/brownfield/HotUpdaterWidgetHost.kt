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
import com.hotupdater.HotUpdaterOptions
import org.json.JSONObject

/**
 * The E2E host's second Hot Updater instance, `widget`: a React Native runtime
 * of its own beside the example's, with its own embedded bundle
 * (`widget.android.bundle`, from `index.widget.js`) on its own channel. Its
 * bundles, crash history, and recovery stay apart from the example's.
 *
 * React Native Brownfield runs one React host, and `getDefaultReactHost` keeps
 * one per process, so this one builds its host itself. A scenario turns it on;
 * every other scenario runs the example alone.
 */
object HotUpdaterWidgetHost {
    private const val MODULE_NAME = "HotUpdaterWidget"
    private const val BUNDLE_ASSET_NAME = "widget.android.bundle"

    private var reactHost: ReactHost? = null
    private var surface: ReactSurface? = null

    /** Whether a scenario turned the widget on, so the host leaves room for it. */
    fun isEnabled(context: Context): Boolean = WidgetRequest.read(context) != null

    /**
     * The widget's React Native root for [activity], or null when it is off.
     * Create it once the example's bundle has loaded, as the iOS host does.
     */
    fun createView(activity: Activity): View? {
        surface?.let { return it.view }
        val request = WidgetRequest.read(activity) ?: return null
        val host = reactHost ?: createReactHost(activity.application, request).also { reactHost = it }
        host.onHostResume(activity)
        val created = host.createSurface(activity, MODULE_NAME, null)
        created.start()
        surface = created
        return created.view
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

    @OptIn(UnstableReactNativeAPI::class)
    private fun createReactHost(
        application: Application,
        request: WidgetRequest,
    ): ReactHost {
        // Its own name keeps its state apart; channel and embedded bundle are
        // the widget's, while the fingerprint and signing key are the app's.
        val widget =
            HotUpdater.init(
                application,
                HotUpdaterOptions(
                    baseURL = request.baseURL,
                    name = "widget",
                    channel = "widget",
                    bundleAssetName = BUNDLE_ASSET_NAME,
                ),
            )
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

/**
 * The widget a scenario turns on. The E2E control server writes it to this
 * app's shared preferences; resetting the app removes it.
 */
private class WidgetRequest(
    val baseURL: String,
) {
    companion object {
        fun read(context: Context): WidgetRequest? {
            val value =
                context
                    .getSharedPreferences("HotUpdaterE2E", Context.MODE_PRIVATE)
                    .getString("widget", null) ?: return null
            return runCatching { WidgetRequest(baseURL = JSONObject(value).getString("baseURL")) }.getOrNull()
        }
    }
}
