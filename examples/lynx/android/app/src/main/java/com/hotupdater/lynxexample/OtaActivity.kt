package com.hotupdater.lynxexample

import android.app.Activity
import android.os.Bundle
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingHost

/** The scaffold supplies native identity and scope; the library owns Lynx. */
class OtaActivity : Activity() {
    private var hotUpdaterHost: HotUpdaterSparklingHost? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        (lastNonConfigurationInstance as? HotUpdaterSparklingHost)?.let { host ->
            hotUpdaterHost = host
            setContentView(host.reattachPrimary(this))
            return
        }
        val embedded = org.json.JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTOR)
        val embeddedBundleId = embedded.getString("bundleId")
        val embeddedManifestHash = embedded.getString("manifestHash")
        val metadata = packageManager.getApplicationInfo(
            packageName,
            android.content.pm.PackageManager.GET_META_DATA,
        ).metaData
        val configuration = HotUpdaterSparklingConfiguration(
            lynx = LynxHostConfiguration(
                runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                channel = "ota-react",
                appVersion = "1.0.0",
                cohort = getSharedPreferences("native-ota-config", MODE_PRIVATE)
                    .getString("cohort", "1")!!,
                embeddedAssetDirectory = "ota/react/A",
                embeddedBundleId = embeddedBundleId,
                embeddedManifestHash = embeddedManifestHash,
                minimumBundleId = embedded.getString("minimumBundleId"),
                publicKeyPem = metadata
                    ?.getString("com.hotupdater.PUBLIC_KEY")
                    ?.replace("\\n", "\n"),
                fingerprintHash = metadata?.getString(
                    "com.hotupdater.FINGERPRINT_HASH",
                ),
            ),
            launchConfiguration = BuildConfig.HOT_UPDATER_APP_BASE_URL
                .takeIf { it.isNotEmpty() }
                ?.let { mapOf("appBaseURL" to it) }
                .orEmpty(),
        )
        val host = HotUpdaterSparklingHost(
            applicationContext,
            configuration,
        )
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
