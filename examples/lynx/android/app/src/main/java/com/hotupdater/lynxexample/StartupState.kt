package com.hotupdater.lynxexample

import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.io.File

/** Private spike receipt supplied by the native fixture driver, not by downloaded JS. */
internal data class Selection(
    val framework: String,
    val slot: String,
    val releaseId: String,
    val bundleId: String? = null,
    val manifestFileHash: String? = null,
) {
    fun json() = JSONObject().put("framework", framework).put("slot", slot).put("releaseId", releaseId)
        .put("bundleId", bundleId).put("manifestFileHash", manifestFileHash)
    companion object {
        fun parse(value: JSONObject) = Selection(value.getString("framework"), value.getString("slot"), value.getString("releaseId"),
            value.optString("bundleId").takeIf { it.isNotBlank() }, value.optString("manifestFileHash").takeIf { it.isNotBlank() })
    }
}

/** A bounded G1 journal. This is not the catalog authorization or OTA installation engine. */
internal class StartupState(context: Context, private val capacityProbe: Boolean = false) {
    val binaryId = cachedBinaryId ?: sha256(File(context.packageCodePath).readBytes()).also { cachedBinaryId = it }
    private val prefs = context.getSharedPreferences("g1-startup-" + binaryId + if (capacityProbe) "-capacity-probe" else "", Context.MODE_PRIVATE)
    init { Log.i("HotUpdaterLynxG1", "native-binary sha256=$binaryId") }
    private fun exclusions() = JSONObject(prefs.getString("excluded", "{}")!!)
    private fun crashes() = JSONObject(prefs.getString("crashedBundles", "{}")!!)
    private fun commit(edit: android.content.SharedPreferences.Editor) {
        check(edit.commit()) { "Could not durably update startup journal" }
    }

    fun recoverPreviousProcess() {
        val pending = prefs.getString("pending", null) ?: return
        val attempt = JSONObject(pending)
        val selection = Selection.parse(attempt.getJSONObject("selection"))
        val reason = if (attempt.optString("failure") == "fatal") "fatal-startup" else "unconfirmed-exit"
        val excluded = exclusions()
        val crashed = crashes()
        if (selection.slot != "A") {
            if (reason == "fatal-startup") crashed.put(requireNotNull(selection.bundleId), attempt.optString("failureMessage"))
            else excluded.put(selection.releaseId, reason)
        }
        commit(prefs.edit().remove("pending").putString("excluded", excluded.toString()).putString("crashedBundles", crashed.toString()))
        Log.i("HotUpdaterLynxG1", "recovered reason=$reason release=${selection.releaseId} exclusions=$excluded crashedBundles=$crashed")
    }

    private fun confirmed(framework: String): Selection? = prefs.getString("confirmed-$framework", null)?.let { Selection.parse(JSONObject(it)) }

    fun select(intent: Intent, framework: String): Selection {
        val slot = intent.getStringExtra("release")
        val requested = if (slot == null) confirmed(framework) ?: Selection(framework, "A", "$framework-embedded")
            else Selection(framework, slot, intent.getStringExtra("releaseId") ?: "$framework-$slot", intent.getStringExtra("bundleId"), intent.getStringExtra("manifestFileHash"))
        require(requested.slot.matches(Regex("[A-Za-z0-9-]+"))) { "Invalid release slot" }
        val excluded = exclusions()
        val crashed = crashes()
        val atCapacity = excluded.length() + crashed.length() >= CAPACITY
        fun allowed(candidate: Selection) = candidate.slot == "A" || (!excluded.has(candidate.releaseId) && !crashed.has(candidate.bundleId ?: "") && (!atCapacity || candidate == confirmed(framework)))
        if (!allowed(requested)) {
            val previous = confirmed(framework)?.takeIf { allowed(it) }
            val fallback = previous ?: Selection(framework, "A", "$framework-embedded")
            Log.i("HotUpdaterLynxG1", "selection-suppressed release=${requested.releaseId} fallback=${fallback.releaseId} exclusions=$excluded")
            return fallback
        }
        return requested
    }

    private fun rejectionKey(selection: Selection): String = sha256((BuildConfig.LYNX_COMPATIBILITY_ID + ":" + selection.framework + ":" + selection.bundleId + ":" + selection.manifestFileHash).toByteArray())

    fun isCompatibilityRejected(selection: Selection): Boolean {
        if (selection.slot == "A") return false
        val cache = JSONObject(prefs.getString("compatibilityRejections", "{}")!!)
        val key = rejectionKey(selection)
        if (!cache.has(key)) return false
        cache.put(key, System.currentTimeMillis())
        commit(prefs.edit().putString("compatibilityRejections", cache.toString()))
        Log.i("HotUpdaterLynxG1", "compatibility-cache-hit bundle=${selection.bundleId} manifest=${selection.manifestFileHash}")
        return true
    }

    fun rejectCompatibility(selection: Selection) {
        val cache = JSONObject(prefs.getString("compatibilityRejections", "{}")!!)
        val key = rejectionKey(selection)
        if (!cache.has(key) && cache.length() >= CAPACITY) {
            val oldest = cache.keys().asSequence().minByOrNull { cache.getLong(it) }
            if (oldest != null) cache.remove(oldest)
        }
        cache.put(key, System.currentTimeMillis())
        commit(prefs.edit().putString("compatibilityRejections", cache.toString()))
        Log.i("HotUpdaterLynxG1", "compatibility-rejected bundle=${selection.bundleId} manifest=${selection.manifestFileHash}")
    }

    fun begin(selection: Selection, data: Map<String, Any>): Boolean {
        check(!prefs.contains("pending")) { "An existing startup attempt cannot be replaced" }
        if (selection == confirmed(selection.framework)) return false
        check(selection.slot == "A" || (!exclusions().has(selection.releaseId) && !crashes().has(selection.bundleId ?: "") && exclusions().length() + crashes().length() < CAPACITY)) { "Candidate is excluded or journal capacity is exhausted" }
        commit(prefs.edit().putString("pending", JSONObject(data).put("selection", selection.json()).toString()))
        return true
    }

    fun fail(attemptId: String, message: String) {
        val pending = prefs.getString("pending", null)?.let { JSONObject(it) } ?: return
        if (pending.optString("attemptId") != attemptId) return
        commit(prefs.edit().putString("pending", pending.put("failure", "fatal").put("failureMessage", message).toString()))
        Log.i("HotUpdaterLynxG1", "fatal-startup-recorded attempt=$attemptId message=$message")
    }

    fun confirm(selection: Selection, attemptId: String) {
        val pending = prefs.getString("pending", null)?.let { JSONObject(it) }
        if (pending == null && selection == confirmed(selection.framework)) return
        check(pending?.optString("attemptId") == attemptId) { "Stale startup attempt" }
        check(pending?.optString("failure") != "fatal") { "Startup failed before confirmation" }
        check(!exclusions().has(selection.releaseId) && !crashes().has(selection.bundleId ?: "")) { "Candidate excluded during startup" }
        commit(prefs.edit().remove("pending").putString("confirmed-${selection.framework}", selection.json().toString()))
    }

    /** Native storage boundary probe in a dedicated task-owned namespace; no engine mocks. */
    fun probeCapacity(): String {
        check(capacityProbe) { "Capacity seeding is forbidden in the application journal" }
        commit(prefs.edit().clear())
        val previous = Selection("react", "confirmed", "capacity-confirmed", "capacity-confirmed-bundle", "capacity-manifest")
        begin(previous, mapOf("attemptId" to "capacity-confirm")); confirm(previous, "capacity-confirm")
        repeat(CAPACITY) { index ->
            val candidate = Selection("react", "candidate-$index", "capacity-release-$index", "capacity-bundle-$index", "capacity-manifest")
            begin(candidate, mapOf("attemptId" to "capacity-attempt-$index")); recoverPreviousProcess()
        }
        val before = exclusions().toString()
        fun input(release: String, id: String) = Intent().putExtra("release", release).putExtra("releaseId", id).putExtra("bundleId", "another-bundle").putExtra("manifestFileHash", "another-manifest")
        check(select(input("new", "new-authorized-release"), "react") == previous)
        check(select(input("old", "capacity-release-0"), "react") == previous)
        check(select(input("new", "new-authorized-release"), "vue").slot == "A")
        check(!begin(previous, mapOf("attemptId" to "confirmed-resume")))
        check(runCatching { begin(Selection("react", "new", "new-authorized-release", "another-bundle", "another-manifest"), mapOf("attemptId" to "must-not-start")) }.isFailure)
        check(exclusions().length() == CAPACITY && exclusions().toString() == before && !prefs.contains("pending"))
        return "capacity=$CAPACITY exclusionsRetained=true confirmedFallback=true embeddedFallback=true newAttemptRefused=true"
    }

    companion object { const val CAPACITY = 128; private var cachedBinaryId: String? = null }
}
