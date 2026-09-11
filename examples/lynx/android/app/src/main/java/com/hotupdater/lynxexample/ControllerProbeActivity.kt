package com.hotupdater.lynxexample

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.util.Log
import android.widget.TextView
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.LynxUpdaterController
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** DUMP-permission native QA; injected events test state ordering, not engine feasibility. */
class ControllerProbeActivity : Activity() {
    private lateinit var text: TextView
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        text = TextView(this).apply { setPadding(24, 70, 24, 24) }
        setContentView(text)
        try {
            when (intent.getStringExtra("scenario")) {
                "journal-failure" -> journalFailure()
                "readiness-race" -> readinessRace()
                "cohort" -> {
                    val cohort = requireNotNull(intent.getStringExtra("cohort"))
                    require(cohort in setOf("1", "2"))
                    check(getSharedPreferences("native-ota-config", MODE_PRIVATE).edit().putString("cohort", cohort).commit())
                    pass("native-cohort=$cohort")
                }
                else -> error("Unknown native controller probe")
            }
        } catch (error: Throwable) { text.text = "Probe rejected: ${error.message}"; Log.e(TAG, "PROBE_REJECT", error) }
    }
    private fun journalFailure() {
        val directory = File(filesDir, "controller-qa/journal-${UUID.randomUUID()}")
        val type = Class.forName("com.hotupdater.lynx.LynxStateStore")
        val store = type.getDeclaredConstructor(File::class.java).newInstance(directory)
        val update = type.declaredMethods.single { it.name == "update" }
        val get = type.declaredMethods.single { it.name == "getValue" }
        val baseline: (JSONObject) -> Unit = { it.put("marker", "confirmed") }
        update.invoke(store, baseline)
        val original = File(directory, "state.json").readBytes()
        val proposed: (JSONObject) -> Unit = { it.put("pending", "candidate") }
        Os.chmod(directory.path, 365) // 0555: force a real staging write failure as the app UID.
        val rejected = try { runCatching { update.invoke(store, proposed) }.isFailure }
        finally { Os.chmod(directory.path, 448) }
        check(rejected && !(get.invoke(store) as JSONObject).has("pending"))
        check(File(directory, "state.json").readBytes().contentEquals(original))
        // Force a checked rename error separately. Restore only this isolated probe file.
        val disk = File(directory, "state.json")
        val saved = File(directory, "saved.json")
        check(disk.renameTo(saved)); check(disk.mkdir())
        val renameRejected = runCatching { update.invoke(store, proposed) }.isFailure
        check(renameRejected && !(get.invoke(store) as JSONObject).has("pending"))
        check(disk.delete()); check(saved.renameTo(disk))
        check(disk.readBytes().contentEquals(original))
        pass("journal-create-failure=true checked-rename-failure=true memoryUnchanged=true persistedBaselineUnchanged=true")
    }
    private fun readinessRace() {
        val controller = LynxUpdaterController(applicationContext, LynxHostConfiguration(
            BuildConfig.LYNX_OTA_COMPATIBILITY_ID, "qa-native-order-${UUID.randomUUID()}", "1.0.0", "ota/react/A", "1"))
        val session = controller.pinPrimary()
        // Synthetic native content/failure observations isolate queue ordering only.
        session.javaClass.getDeclaredField("firstScreen").also { it.isAccessible = true }.setBoolean(session, true)
        val notify = session.javaClass.declaredMethods.single { it.name.startsWith("notifyReady") }
        val failure = controller.javaClass.declaredMethods.single { it.name.startsWith("fail") }
        val callback: (Result<JSONObject>) -> Unit = { result ->
            check(result.isFailure) { "Queued ready confirmed after observed fatal failure" }
            val directory = controller.javaClass.getDeclaredField("directory").also { it.isAccessible = true }.get(controller) as File
            val journal = JSONObject(File(directory, "state.json").readText())
            check(journal.getJSONObject("pending").getBoolean("fatal") && !journal.has("confirmed"))
            session.close()
            pass("queuedReadyRejected=true durablePendingFatal=true confirmedAbsent=true syntheticEventOrderingOnly=true")
        }
        Handler(Looper.getMainLooper()).post { notify.invoke(session, callback) }
        failure.invoke(controller, session, "Synthetic native failure observed before main queue drains")
    }
    private fun pass(message: String) { text.text = message; Log.i(TAG, "PROBE_PASS $message") }
    companion object { private const val TAG = "HotUpdaterLynxControllerQA" }
}
