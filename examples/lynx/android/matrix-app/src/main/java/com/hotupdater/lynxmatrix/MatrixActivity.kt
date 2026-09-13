package com.hotupdater.lynxmatrix

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingEventListener
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingHost
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingStaleProbe
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingView
import java.io.File
import java.time.Instant
import org.json.JSONObject

/** QA-only shell. Every lifecycle action delegates to the packaged host API. */
class MatrixActivity : Activity() {
    private lateinit var host: HotUpdaterSparklingHost
    private lateinit var content: LinearLayout
    private var views = emptyList<HotUpdaterSparklingView>()
    private var staleProbe: HotUpdaterSparklingStaleProbe? = null

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val framework = intent.getStringExtra("framework") ?: "react"
        require(framework in setOf("react", "vue", "octane"))
        val embedded = JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTORS)
            .getJSONObject(framework)
        val embeddedBundleId = embedded.getString("bundleId")
        val embeddedManifestHash = embedded.getString("manifestHash")
        host = HotUpdaterSparklingHost(
            applicationContext,
            HotUpdaterSparklingConfiguration(
                lynx = LynxHostConfiguration(
                    runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                    channel = intent.getStringExtra("channel") ?: "ota-$framework",
                    appVersion = "1.0.0",
                    cohort = "1",
                    embeddedAssetDirectory = intent.getStringExtra("embeddedDir")
                        ?: "ota/$framework/A",
                    embeddedBundleId = embeddedBundleId,
                    embeddedManifestHash = embeddedManifestHash,
                    minimumBundleId = embedded.getString("minimumBundleId"),
                ),
                requiredStartupResourcePaths = startupResources(
                    intent.getStringExtra("resourceSet") ?: "sdk3",
                ),
            ),
            HotUpdaterSparklingEventListener { name, details ->
                val event = JSONObject(details)
                    .put("event", name)
                    .put("observedAt", Instant.now().toString())
                    .put("framework", framework)
                val encoded = event.toString()
                synchronized(MatrixActivity::class.java) {
                    File(filesDir, "matrix-events.jsonl").appendText("$encoded\n")
                }
                Log.i("HotUpdaterLynx", "HOT_UPDATER_MATRIX_EVENT $encoded")
            },
        )
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        actions.addView(button("Replace primary") {
            staleProbe = host.captureDiagnosticAuthorities()
            views.first().close()
            show(host.createViews(this, count = 2))
        })
        actions.addView(button("Verify stale after reload") {
            checkNotNull(staleProbe).verifyStaleAuthorities()
        })
        actions.addView(button("Fail secondary") {
            staleProbe = host.captureDiagnosticAuthorities()
            views[1].triggerFatalFailureForDiagnostics()
        })
        content.addView(actions)
        setContentView(content)
        show(host.createViews(this, count = 2))
        staleProbe = host.captureDiagnosticAuthorities()
    }

    override fun onDestroy() {
        host.close()
        super.onDestroy()
    }

    private fun show(next: List<HotUpdaterSparklingView>) {
        views.forEach { (it.parent as? LinearLayout)?.removeView(it) }
        views = next
        next.forEach {
            content.addView(it, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ))
        }
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        contentDescription = label
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
    }

    private fun startupResources(resourceSet: String): Set<String> = when (resourceSet) {
        "sdk1" -> setOf("main.lynx.bundle", "assets/probe.png")
        "sdk2", "sdk3" -> setOf(
            "main.lynx.bundle",
            "assets/probe.png",
            "assets/probe.ttf",
            "assets/bootstrap.js",
            "dynamic/component.lynx.bundle",
        )
        else -> error("Unknown OTA resource set: $resourceSet")
    }
}
