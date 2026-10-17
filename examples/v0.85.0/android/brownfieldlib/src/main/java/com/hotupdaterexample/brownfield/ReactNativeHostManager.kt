package com.hotupdaterexample.brownfield

import android.app.Application
import android.content.Context
import com.callstack.reactnativebrownfield.OnJSBundleLoaded
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.hotupdater.HotUpdater
import com.hotupdater.HotUpdaterCheckOptions
import com.hotupdater.HotUpdaterOptions
import com.hotupdater.HotUpdaterUpdateStrategy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Starts React Native for the brownfield E2E host, as the brownfield guide
 * does: when a scenario turns it on, a `HotUpdaterInstance` checks for an
 * update first.
 */
object ReactNativeHostManager {
    // Outlives every activity, so closing a screen never cancels the start.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val onStarted = mutableListOf<() -> Unit>()
    private var started = false
    private val onBundleLoaded = mutableListOf<() -> Unit>()
    private var bundleLoaded = false

    fun start(application: Application) {
        scope.launch {
            NativeUpdateCheckRequest.read(application)?.let { request ->
                request.report(checkForUpdate(application, request))
            }
            val loaded =
                OnJSBundleLoaded {
                    scope.launch {
                        bundleLoaded = true
                        onBundleLoaded.toList().forEach { it() }
                        onBundleLoaded.clear()
                    }
                }
            ReactNativeBrownfield.initialize(application, loaded) {
                getDefaultReactHost(
                    context = application,
                    packageList = PackageList(application).packages,
                    jsMainModulePath = "index",
                    jsBundleAssetPath = "index.android.bundle",
                    jsBundleFilePath = HotUpdater.getJSBundleFile(application),
                    useDevSupport = false,
                    jsRuntimeFactory = null,
                )
            }
            HotUpdater.setReactHost(ReactNativeBrownfield.shared.reactHost)
            started = true
            onStarted.toList().forEach { it() }
            onStarted.clear()
        }
    }

    /**
     * The brownfield guide's update check: checks, and waits up to the
     * request's timeout for a required update, which then runs in this start.
     * The timeout ends the wait, not the download.
     */
    private suspend fun checkForUpdate(
        application: Application,
        request: NativeUpdateCheckRequest,
    ): String =
        withTimeoutOrNull(request.checkTimeoutMillis) {
            try {
                val hotUpdater =
                    HotUpdater.init(
                        application,
                        HotUpdaterOptions(baseURL = request.baseURL, requestTimeoutMillis = request.requestTimeoutMillis),
                    )
                val strategy =
                    if (request.updateStrategy == "fingerprint") {
                        HotUpdaterUpdateStrategy.FINGERPRINT
                    } else {
                        HotUpdaterUpdateStrategy.APP_VERSION
                    }
                val update =
                    hotUpdater.checkForUpdate(HotUpdaterCheckOptions(updateStrategy = strategy))
                        ?: return@withTimeoutOrNull "upToDate"
                when {
                    // A newer Release of the bundle this start runs: nothing to download.
                    update.transitionKind == "ADOPT_RELEASE" -> if (update.updateBundle()) "upToDate" else "failed"

                    // Downloads in the background.
                    !update.shouldForceUpdate -> "pending".also { scope.launch { runCatching { update.updateBundle() } } }

                    update.updateBundle() -> "ready"

                    else -> "failed"
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                "failed"
            }
        } ?: "pending"

    /** Runs [callback] on the main thread once React Native has started. */
    fun whenStarted(callback: () -> Unit) {
        if (started) callback() else onStarted.add(callback)
    }

    /**
     * Runs [callback] on the main thread once the JavaScript bundle has loaded,
     * when React Native can take a deep link: before that, its React host drops
     * new intents.
     */
    fun whenBundleLoaded(callback: () -> Unit) {
        if (bundleLoaded) callback() else onBundleLoaded.add(callback)
    }
}

/**
 * The native update check a scenario turns on. The E2E control server writes
 * it to this app's shared preferences; resetting the app removes it.
 */
private class NativeUpdateCheckRequest(
    val baseURL: String,
    val updateStrategy: String,
    val nonce: String,
    val requestTimeoutMillis: Long,
    val checkTimeoutMillis: Long,
) {
    /** Publishes `<nonce>:<status>` to the control server's screen state. */
    suspend fun report(status: String) {
        withContext(Dispatchers.IO) {
            runCatching {
                val base = URL(baseURL)
                val connection = URL(base.protocol, base.host, base.port, "/e2e/screen-state").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 5_000
                connection.readTimeout = 5_000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use {
                    it.write(JSONObject().put("nativeCheckResult", "$nonce:$status").toString().toByteArray())
                }
                connection.responseCode
                connection.disconnect()
            }
        }
    }

    companion object {
        fun read(context: Context): NativeUpdateCheckRequest? {
            val value =
                context
                    .getSharedPreferences("HotUpdaterE2E", Context.MODE_PRIVATE)
                    .getString("nativeCheck", null) ?: return null
            return runCatching {
                val json = JSONObject(value)
                NativeUpdateCheckRequest(
                    baseURL = json.getString("baseURL"),
                    updateStrategy = json.getString("updateStrategy"),
                    nonce = json.getString("nonce"),
                    requestTimeoutMillis = json.optLong("requestTimeoutMs", 5_000),
                    checkTimeoutMillis = json.optLong("checkTimeoutMs", 10_000),
                )
            }.getOrNull()
        }
    }
}
