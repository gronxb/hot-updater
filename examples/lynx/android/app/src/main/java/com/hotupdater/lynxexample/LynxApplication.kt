package com.hotupdater.lynxexample

import android.app.Application
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.LynxHostConfigurationProvider
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingModules
import com.tiktok.sparkling.hybridkit.HybridKit
import com.tiktok.sparkling.hybridkit.config.BaseInfoConfig
import com.tiktok.sparkling.hybridkit.config.SparklingHybridConfig
import com.tiktok.sparkling.hybridkit.config.SparklingLynxConfig

class LynxApplication : Application(), LynxHostConfigurationProvider {
    override fun createLynxHostConfiguration(): LynxHostConfiguration {
        val embedded = org.json.JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTOR)
        val metadata = packageManager.getApplicationInfo(
            packageName, android.content.pm.PackageManager.GET_META_DATA,
        ).metaData
        return LynxHostConfiguration(
            runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
            channel = "ota-react",
            appVersion = "1.0.0",
            cohort = getSharedPreferences("native-ota-config", MODE_PRIVATE).getString("cohort", "1")!!,
            embeddedAssetDirectory = "ota/react/A",
            embeddedBundleId = embedded.getString("bundleId"),
            embeddedManifestHash = embedded.getString("manifestHash"),
            minimumBundleId = embedded.getString("minimumBundleId"),
            publicKeyPem = metadata?.getString("com.hotupdater.PUBLIC_KEY")?.replace("\\n", "\n"),
            fingerprintHash = metadata?.getString("com.hotupdater.FINGERPRINT_HASH"),
        )
    }

    override fun onCreate() {
        super.onCreate()
        val factory = PoolFactory(PoolConfig.newBuilder().build())
        Fresco.initialize(
            this,
            ImagePipelineConfig.newBuilder(this)
                .setPoolFactory(factory)
                .build(),
        )
        HybridKit.init(this)
        val lynx = SparklingLynxConfig.build(this) {
            addLynxModules(HotUpdaterSparklingModules.modules())
        }
        HybridKit.setHybridConfig(
            SparklingHybridConfig.build(BaseInfoConfig(isDebug = false)) {
                setLynxConfig(lynx)
            },
            this,
        )
        HybridKit.initLynxKit()
    }
}
