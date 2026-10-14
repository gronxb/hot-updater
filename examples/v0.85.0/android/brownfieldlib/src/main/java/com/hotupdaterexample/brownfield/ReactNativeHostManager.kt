package com.hotupdaterexample.brownfield

import android.app.Application
import android.content.Context
import com.callstack.reactnativebrownfield.ReactNativeBrownfield
import com.facebook.react.PackageList
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.hotupdater.HotUpdater
import com.hotupdater.HotUpdaterCheckOptions
import com.hotupdater.HotUpdaterPrepareResult
import com.hotupdater.HotUpdaterUpdateStrategy
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Starts React Native for the brownfield E2E host, as the brownfield guide
 * does: when a scenario turns it on, `HotUpdater.prepare` checks for an update
 * first.
 */
object ReactNativeHostManager {
    // Outlives every activity, so closing a screen never cancels the start.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val onStarted = mutableListOf<() -> Unit>()
    private var started = false

    fun start(application: Application) {
        scope.launch {
            NativePrepareRequest.read(application)?.let { request ->
                val result =
                    HotUpdater.prepare(
                        application,
                        HotUpdaterCheckOptions(
                            baseURL = request.baseURL,
                            updateStrategy =
                                if (request.updateStrategy == "fingerprint") {
                                    HotUpdaterUpdateStrategy.FINGERPRINT
                                } else {
                                    HotUpdaterUpdateStrategy.APP_VERSION
                                },
                            requestTimeoutMillis = request.requestTimeoutMillis,
                        ),
                        timeoutMillis = 10_000,
                    )
                request.report(result)
            }
            ReactNativeBrownfield.initialize(application) {
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

    /** Runs [callback] on the main thread once React Native has started. */
    fun whenStarted(callback: () -> Unit) {
        if (started) callback() else onStarted.add(callback)
    }
}

/**
 * The native update check a scenario turns on. The E2E control server writes
 * it to this app's shared preferences; resetting the app removes it.
 */
private class NativePrepareRequest(
    val baseURL: String,
    val updateStrategy: String,
    val nonce: String,
    val requestTimeoutMillis: Long,
) {
    /** Publishes `<nonce>:<status>` to the control server's screen state. */
    suspend fun report(result: HotUpdaterPrepareResult) {
        val status =
            when (result) {
                HotUpdaterPrepareResult.UpToDate -> "upToDate"
                is HotUpdaterPrepareResult.Ready -> "ready"
                is HotUpdaterPrepareResult.Pending -> "pending"
                is HotUpdaterPrepareResult.Failed -> "failed"
            }
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
                    it.write(JSONObject().put("nativePrepareResult", "$nonce:$status").toString().toByteArray())
                }
                connection.responseCode
                connection.disconnect()
            }
        }
    }

    companion object {
        fun read(context: Context): NativePrepareRequest? {
            val value =
                context
                    .getSharedPreferences("HotUpdaterE2E", Context.MODE_PRIVATE)
                    .getString("nativePrepare", null) ?: return null
            return runCatching {
                val json = JSONObject(value)
                NativePrepareRequest(
                    baseURL = json.getString("baseURL"),
                    updateStrategy = json.getString("updateStrategy"),
                    nonce = json.getString("nonce"),
                    requestTimeoutMillis = json.optLong("requestTimeoutMs", 5_000),
                )
            }.getOrNull()
        }
    }
}
