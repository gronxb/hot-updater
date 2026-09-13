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
        val framework = intent.getStringExtra("framework") ?: "react"
        require(framework in setOf("react", "vue", "octane"))
        val embeddedDir = intent.getStringExtra("embeddedDir")
            ?: "ota/$framework/A"
        val embedded = org.json.JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTORS)
            .getJSONObject(framework)
        val embeddedBundleId = embedded.getString("bundleId")
        val embeddedManifestHash = embedded.getString("manifestHash")
        val metadata = packageManager.getApplicationInfo(
            packageName,
            android.content.pm.PackageManager.GET_META_DATA,
        ).metaData
        val configuration = HotUpdaterSparklingConfiguration(
            lynx = LynxHostConfiguration(
                runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                channel = intent.getStringExtra("channel") ?: "ota-$framework",
                appVersion = "1.0.0",
                cohort = getSharedPreferences("native-ota-config", MODE_PRIVATE)
                    .getString("cohort", "1")!!,
                embeddedAssetDirectory = embeddedDir,
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
            requiredStartupResourcePaths = startupResources(
                intent.getStringExtra("resourceSet") ?: "sdk3",
            ),
        )
        val host = HotUpdaterSparklingHost(
            applicationContext,
            configuration,
        )
        hotUpdaterHost = host
        setContentView(host.createView(this))
    }

    override fun onDestroy() {
        hotUpdaterHost?.close()
        hotUpdaterHost = null
        super.onDestroy()
    }
    private fun startupResources(resourceSet: String): Set<String> = when (resourceSet) {
        "sdk1" -> setOf("main.lynx.bundle", "assets/probe.png")
        "sdk2" -> setOf(
            "main.lynx.bundle",
            "assets/probe.png",
            "assets/probe.ttf",
            "assets/bootstrap.js",
            "dynamic/component.lynx.bundle",
        )
        "sdk3" -> setOf(
            "main.lynx.bundle",
            "assets/probe.png",
            "assets/probe.ttf",
            "assets/bootstrap.js",
            "dynamic/component.lynx.bundle",
        )
        else -> error("Unknown OTA resource set: $resourceSet")
    }
}
