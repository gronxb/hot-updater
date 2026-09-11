package com.hotupdater.lynxexample

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.LynxLaunchSession
import com.hotupdater.lynx.LynxUpdaterController
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.tiktok.sparkling.SparklingContext
import com.tiktok.sparkling.hybridkit.base.HybridKitType
import com.tiktok.sparkling.hybridkit.lynx.SimpleLynxKitView
import com.tiktok.sparkling.hybridkit.scheme.HybridSchemeParam

/** Each native example entry owns its channel; downloaded code cannot change it. */
class OtaActivity : Activity() {
    private var launch: LynxLaunchSession? = null
    private var view: LynxView? = null
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        try {
            val framework = intent.getStringExtra("framework") ?: "react"
            require(framework in setOf("react", "vue", "octane"))
            val existing = processController
            check(existing == null || processFramework == framework) { "Framework selection is pinned until process restart" }
            val channel = intent.getStringExtra("channel") ?: "ota-$framework"
            val embeddedDir = intent.getStringExtra("embeddedDir") ?: "ota/$framework/A"
            val controller = existing ?: LynxUpdaterController(applicationContext, LynxHostConfiguration(
                runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                channel = channel, appVersion = "1.0.0", cohort = getSharedPreferences("native-ota-config", MODE_PRIVATE).getString("cohort", "1")!!,
                embeddedAssetDirectory = embeddedDir,
            )).also { processController = it; processFramework = framework }
            val session = if (intent.getBooleanExtra("secondary", false)) controller.pinSecondary() else controller.pinPrimary()
            if ("assets/probe.ttf" in session.installation.managedPaths) session.requireFontBeforeReady("assets/probe.ttf")
            launch = session
            val entry = session.entryUrl
            val sparkling = SparklingContext().apply {
                hybridSchemeParam = HybridSchemeParam(engineType = HybridKitType.LYNX, bundle = entry)
                scheme = "hybrid://lynxview_page?bundle=$entry"
                containerId = java.util.UUID.randomUUID().toString()
            }
            val builder = LynxViewBuilder().also { session.configure(it) }
            val kit = SimpleLynxKitView(this, sparkling, builder, null, null)
            val lynxView = kit.realView() as LynxView
            view = lynxView
            session.bind(lynxView)
            setContentView(lynxView)
            kit.load()
        } catch (error: Exception) {
            Log.e("HotUpdaterLynx", "host-rejected-before-evaluation", error)
            setContentView(TextView(this).apply { text = "Native Lynx host rejected\n${error.message}"; setPadding(24, 70, 24, 24) })
        }
    }
    override fun onDestroy() { launch?.close(); view?.destroy(); super.onDestroy() }
    companion object {
        private var processController: LynxUpdaterController? = null
        private var processFramework: String? = null
    }
}
