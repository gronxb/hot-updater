package com.hotupdater.lynxmatrix

import android.app.Activity
import android.os.Bundle
import android.os.Process
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingConfiguration
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingEventListener
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingHost
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingStaleProbe
import com.hotupdater.lynx.sparkling.RuntimeJournalDiagnostics
import com.hotupdater.lynx.sparkling.armNextPageFatalFailureForDiagnostics
import com.hotupdater.lynx.sparkling.armNextPageAdmissionPendingForDiagnostics
import com.hotupdater.lynx.sparkling.captureDiagnosticAuthorities
import com.hotupdater.lynx.sparkling.exerciseNavigationStackBoundaryForDiagnostics
import com.hotupdater.lynx.sparkling.triggerReloadForDiagnostics
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/** QA-only entry Activity; managed navigation uses packaged page Activities. */
class MatrixActivity : Activity() {
    private var host: HotUpdaterSparklingHost? = null
    private var staleProbe: HotUpdaterSparklingStaleProbe? = null
    private var controls: LinearLayout? = null
    private val runtimeJournal by lazy { RuntimeJournalDiagnostics(filesDir) }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        (lastNonConfigurationInstance as? HotUpdaterSparklingHost)?.let { retained ->
            host = retained
            setContentView(retained.reattachPrimary(this))
            installDiagnosticControls()
            return
        }
        val framework = intent.getStringExtra("framework") ?: "react"
        require(framework in setOf("react", "vue", "octane"))
        val embedded = JSONObject(BuildConfig.LYNX_EMBEDDED_DESCRIPTORS)
            .getJSONObject(framework)
        val managedHost = HotUpdaterSparklingHost(
            applicationContext,
            HotUpdaterSparklingConfiguration(
                lynx = LynxHostConfiguration(
                    runtimeId = BuildConfig.LYNX_OTA_COMPATIBILITY_ID,
                    channel = intent.getStringExtra("channel")
                        ?: "ota-$framework",
                    appVersion = "1.0.0",
                    cohort = "1",
                    embeddedAssetDirectory = intent.getStringExtra("embeddedDir")
                        ?: "ota/$framework/A",
                    embeddedBundleId = embedded.getString("bundleId"),
                    embeddedManifestHash = embedded.getString("manifestHash"),
                    minimumBundleId = embedded.getString("minimumBundleId"),
                ),
                allowDiagnosticIntentLaunchConfiguration = true,
            ),
            HotUpdaterSparklingEventListener { name, details ->
                if (name == "generationWillRetire" && details["reason"] == "reload") {
                    staleProbe = checkNotNull(host).captureDiagnosticAuthorities()
                }
                val event = JSONObject(details)
                    .put("event", name)
                    .put("observedAt", observedAt())
                    .put("framework", framework)
                val encoded = event.toString()
                appendRecord("matrix-events.jsonl", encoded)
                Log.i(
                    "HotUpdaterLynx",
                    "HOT_UPDATER_MATRIX_EVENT $encoded",
                )
                if (name == "generationStarted") {
                    runOnUiThread(::installDiagnosticControls)
                }
            },
        )
        host = managedHost
        setContentView(managedHost.createView(this))
        installDiagnosticControls()
    }

    private fun observedAt(): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).run {
            timeZone = TimeZone.getTimeZone("UTC")
            format(Date())
        }

    private fun installDiagnosticControls() {
        (controls?.parent as? ViewGroup)?.removeView(controls)
        controls = LinearLayout(this).also { row ->
            row.orientation = LinearLayout.HORIZONTAL
            row.setBackgroundColor(0xccffffff.toInt())
            row.addView(action("Verify stale after reload") {
                checkNotNull(staleProbe).verifyStaleAuthorities()
                staleProbe = null
            })
            row.addView(action("Fail secondary") {
                val managedHost = checkNotNull(host)
                managedHost.armNextPageFatalFailureForDiagnostics()
            })
            row.addView(action("Hold secondary") {
                checkNotNull(host)
                    .armNextPageAdmissionPendingForDiagnostics()
            })
            row.addView(action("Reload pending") {
                checkNotNull(host).triggerReloadForDiagnostics { result ->
                    result.exceptionOrNull()?.let { error ->
                        Log.e("HotUpdaterLynx", "Pending reload failed", error)
                    }
                }
            })
            row.addView(action("Exercise stack boundary") {
                checkNotNull(host)
                    .exerciseNavigationStackBoundaryForDiagnostics { result ->
                        recordDiagnostic("navigationStackBoundary", result)
                    }
            })
            row.addView(action("Exercise event boundaries") {
                Thread {
                    recordDiagnostic(
                        "runtimeEventFieldBoundaries",
                        runCatching {
                            JSONObject()
                                .put(
                                    "result",
                                    runtimeJournal.exerciseFieldBoundaries(),
                                )
                                .put(
                                    "receipt",
                                    receiptSummary(runtimeJournal.receipt()),
                                )
                        },
                    )
                }.start()
            })
            row.addView(action("Exercise journal fixtures") {
                Thread {
                    recordDiagnostic(
                        "runtimeJournalFixtures",
                        runCatching(::exerciseRuntimeJournalFixtures),
                    )
                }.start()
            })
        }
        addContentView(
            controls,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP,
            ),
        )
    }

    private fun action(title: String, perform: () -> Unit) =
        Button(this).apply {
            text = title
            contentDescription = title
            setOnClickListener { perform() }
            layoutParams = LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f,
            )
        }

    private fun exerciseRuntimeJournalFixtures(): JSONObject {
        val cases = JSONArray()
        try {
            listOf(
                "retention-limit",
                "count-plus-one",
                "byte-plus-one",
                "corrupt-json",
                "noncanonical",
                "already-oversized",
            ).forEach { mode ->
                runtimeJournal.install(mode)
                val item = JSONObject()
                    .put("mode", mode)
                    .put("installed", receiptSummary(runtimeJournal.receipt()))
                if (mode != "retention-limit") {
                    runtimeJournal.append()
                    item.put(
                        "afterAppend",
                        receiptSummary(runtimeJournal.receipt()),
                    )
                }
                runtimeJournal.reopen()
                item.put(
                    "afterReopen",
                    receiptSummary(runtimeJournal.receipt()),
                )
                cases.put(item)
            }
        } finally {
            runtimeJournal.restore()
        }
        return JSONObject()
            .put("fixtures", cases)
            .put("restored", receiptSummary(runtimeJournal.receipt()))
    }

    private fun receiptSummary(receipt: JSONObject): JSONObject {
        val snapshot = receipt.getJSONObject("snapshot")
        val events = snapshot.getJSONArray("events")
        return JSONObject()
            .put("processId", receipt.getString("processId"))
            .put("schemaVersion", snapshot.getInt("schemaVersion"))
            .put("oldestSequence", snapshot.get("oldestSequence"))
            .put("latestSequence", snapshot.get("latestSequence"))
            .put("truncated", snapshot.getBoolean("truncated"))
            .put("eventCount", events.length())
            .put("byteLength", receipt.getInt("byteLength"))
            .put("sha256", receipt.getString("sha256"))
            .put("canonicalUtf8", receipt.get("canonicalUtf8"))
    }

    private fun recordDiagnostic(
        action: String,
        result: Result<JSONObject>,
    ) {
        val record = result.fold(
            onSuccess = { data ->
                JSONObject()
                    .put("action", action)
                    .put("ok", true)
                    .put("data", data)
            },
            onFailure = { error ->
                JSONObject()
                    .put("action", action)
                    .put("ok", false)
                    .put("error", error.message ?: "Diagnostic action rejected")
            },
        )
        val encoded = record.put("processId", Process.myPid().toString()).toString()
        appendRecord("matrix-diagnostics.jsonl", encoded)
        Log.i("HotUpdaterLynx", "HOT_UPDATER_MATRIX_DIAGNOSTIC $encoded")
    }

    private fun appendRecord(name: String, encoded: String) {
        synchronized(MatrixActivity::class.java) {
            val destination = File(filesDir, name)
            val pending = File(filesDir, "$name.pending")
            pending.outputStream().use { output ->
                if (destination.exists()) {
                    destination.inputStream().use { it.copyTo(output) }
                }
                output.write("$encoded\n".toByteArray(Charsets.UTF_8))
            }
            check(pending.renameTo(destination)) { "Could not publish $name" }
        }
    }

    override fun onDestroy() {
        if (isChangingConfigurations) {
            host?.primaryActivityDetachedForRecreation(this)
        } else {
            host?.close()
        }
        host = null
        staleProbe = null
        controls = null
        super.onDestroy()
    }

    override fun onRetainNonConfigurationInstance(): Any? = host
}
