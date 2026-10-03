package com.hotupdater.lynxexample

import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingActivity
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingLaunchConfiguration
import org.json.JSONObject

/** Nonproduction shell for the shipped end-to-end scenario. */
class OtaActivity : HotUpdaterSparklingActivity() {
    override fun createHotUpdaterConfiguration(): HotUpdaterSparklingConfiguration {
        val launchConfiguration = HotUpdaterSparklingLaunchConfiguration.from(this)
        val embedded = JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTOR)
        val metadata = packageManager.getApplicationInfo(
            packageName,
            android.content.pm.PackageManager.GET_META_DATA,
        ).metaData
        return HotUpdaterSparklingConfiguration(
            lynx = LynxHostConfiguration(
                runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                channel = launchConfiguration["channel"] ?: "ota-react",
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
    }
}
