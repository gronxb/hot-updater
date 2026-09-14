package com.hotupdater.lynxexample

import android.app.Activity
import android.os.Bundle
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingHost
import org.json.JSONObject

/** Nonproduction shell for the shipped end-to-end scenario. */
class OtaActivity : Activity() {
    private var hotUpdaterHost: HotUpdaterSparklingHost? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        (lastNonConfigurationInstance as? HotUpdaterSparklingHost)?.let { host ->
            hotUpdaterHost = host
            setContentView(host.reattachPrimary(this))
            return
        }
        val embedded = JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTOR)
        val metadata = packageManager.getApplicationInfo(
            packageName,
            android.content.pm.PackageManager.GET_META_DATA,
        ).metaData
        val configuration = HotUpdaterSparklingConfiguration(
            lynx = LynxHostConfiguration(
                runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                channel = intent.getStringExtra("channel") ?: "ota-react",
                appVersion = "1.0.0",
                cohort = getSharedPreferences("native-ota-config", MODE_PRIVATE)
                    .getString("cohort", "1")!!,
                embeddedAssetDirectory = intent.getStringExtra("embeddedDir")
                    ?: "ota/react/A",
                embeddedBundleId = embedded.getString("bundleId"),
                embeddedManifestHash = embedded.getString("manifestHash"),
                minimumBundleId = embedded.getString("minimumBundleId"),
                publicKeyPem = metadata
                    ?.getString("com.hotupdater.PUBLIC_KEY")
                    ?.replace("\\n", "\n"),
                fingerprintHash = metadata?.getString(
                    "com.hotupdater.FINGERPRINT_HASH",
                ),
            ),
            allowDiagnosticIntentLaunchConfiguration = true,
        )
        val host = HotUpdaterSparklingHost(applicationContext, configuration)
        hotUpdaterHost = host
        setContentView(host.createView(this))
    }

    override fun onDestroy() {
        if (isChangingConfigurations) {
            hotUpdaterHost?.primaryActivityDetachedForRecreation(this)
        } else {
            hotUpdaterHost?.close()
        }
        hotUpdaterHost = null
        super.onDestroy()
    }

    override fun onRetainNonConfigurationInstance(): Any? = hotUpdaterHost
}
