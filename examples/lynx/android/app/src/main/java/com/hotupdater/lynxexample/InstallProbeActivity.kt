package com.hotupdater.lynxexample

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import com.hotupdater.lynx.LynxArtifactInstaller
import com.hotupdater.lynx.LynxArtifactRequest
import com.hotupdater.lynx.LynxInstallConfiguration
import com.hotupdater.lynx.VerifiedLynxInstallation
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/** Shell-only native artifact QA. This never authorizes or activates a catalog selection. */
class InstallProbeActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var status: TextView
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        status = TextView(this).apply { text = "Native artifact verification in progress"; setPadding(24, 70, 24, 24) }
        setContentView(status)
        scope.launch {
            try { val result = withContext(Dispatchers.IO) { runProbe() }; status.text = "Native artifact probe passed\n$result"; Log.i(TAG, "PROBE_PASS $result") }
            catch (error: Throwable) { status.text = "Native artifact probe rejected\n${error.javaClass.simpleName}: ${error.message}"; Log.i(TAG, "PROBE_REJECT ${error.javaClass.simpleName}: ${error.message}") }
        }
    }
    private suspend fun runProbe(): String {
        val scenario = intent.getStringExtra("scenario") ?: "install"
        if (scenario == "capacity") return StartupState(applicationContext, capacityProbe = true).probeCapacity()
        val root = File(filesDir, "lynx-installer-g2").canonicalFile
        if (scenario == "inspect") return "installedTree=${treeHash(File(root, "installations"))} preparations=${File(root, "preparations").list().orEmpty().size}"
        val publicKey = if (BuildConfig.LYNX_PROBE_SIGNING) assets.open("native-public-key.pem").bufferedReader().use { it.readText() } else null
        val configuration = LynxInstallConfiguration(BuildConfig.LYNX_COMPATIBILITY_ID, publicKey)
        val installer = LynxArtifactInstaller(root, configuration)
        val receipt = fetchReceipt(requireNotNull(intent.getStringExtra("receiptUrl")))
        val original = request(receipt)
        val before = treeHash(File(root, "installations"))
        Log.i(TAG, "PROBE_BEGIN scenario=$scenario bundle=${original.bundleId} signing=${BuildConfig.LYNX_PROBE_SIGNING} installedTree=$before")
        val input = when (scenario) {
            "bad-hash" -> original.copy(fileHash = "0".repeat(64))
            "bad-signature" -> original.copy(fileHash = "sig:" + "A".repeat(344))
            "unsigned-manifest" -> original.copy(manifestFileHash = "0".repeat(64))
            "signed-manifest" -> original.copy(manifestFileHash = receipt.getString("persistedManifestFileHash"))
            "truncated" -> original.copy(fileUrl = original.fileUrl.replace(":18791/files/", ":18792/qa/truncated/"))
            "cancel-download", "cancel-job", "slow" -> original.copy(fileUrl = original.fileUrl.replace(":18791/files/", ":18792/qa/slow/"))
            else -> original
        }
        // A deliberately native-only finalization seam. The production controller must
        // replace this with its current catalog, revision and exclusion transaction.
        val authorityLock = Any()
        var revoked = false
        fun publish(installerPublish: () -> VerifiedLynxInstallation): VerifiedLynxInstallation = synchronized(authorityLock) {
            check(!revoked) { "Native test authority changed before publication" }
            installerPublish()
        }
        try {
            if (scenario == "cancel-job" || scenario == "cancel-handoff") {
                val queue = java.util.concurrent.LinkedBlockingQueue<Runnable>()
                val queuedDispatcher = object : CoroutineDispatcher() {
                    override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) { queue.put(block) }
                }
                val job = CoroutineScope(SupervisorJob() + if (scenario == "cancel-handoff") queuedDispatcher else Dispatchers.IO).async(start = if (scenario == "cancel-handoff") CoroutineStart.UNDISPATCHED else CoroutineStart.DEFAULT) {
                    installer.prepare(input) { bytes -> Log.i(TAG, "CANCELLABLE_DOWNLOAD bytes=$bytes") }
                }
                if (scenario == "cancel-handoff") {
                    val handoff = withContext(Dispatchers.IO) { queue.poll(30, java.util.concurrent.TimeUnit.SECONDS) }
                    checkNotNull(handoff) { "Preparation did not reach verified return dispatch" }
                    job.cancel(CancellationException("Cancel verified return before token handoff"))
                    handoff.run()
                    while (!job.isCompleted) queue.poll(100, java.util.concurrent.TimeUnit.MILLISECONDS)?.run()
                } else {
                    delay(1000)
                    job.cancelAndJoin()
                }
                check(job.isCancelled)
                check(File(root, "preparations").list().orEmpty().isEmpty()) { "Canceled preparation leaked its private directory" }
                check(before == treeHash(File(root, "installations")))
                return "scenario=$scenario actualJobCancelled=true preparations=0 installedTree=$before"
            }
            if (scenario == "concurrent") {
                val results = coroutineScope {
                    listOf(async { installer.prepare(input) }, async { installer.prepare(input) }).map { it.await() }
                        .map { prepared -> async { installer.commitPrepared(prepared, ::publish) } }.map { it.await() }
                }
                check(results[0].directory == results[1].directory && results[0].manifestHash == results[1].manifestHash)
                return "scenario=concurrent bundle=${input.bundleId} oneImmutableDirectory=${results[0].directory}"
            }
            val prepared = installer.prepare(input) { bytes ->
                Log.i(TAG, "DOWNLOAD bundle=${input.bundleId} bytes=$bytes")
                if (scenario == "cancel-download" && bytes > 0) throw CancellationException("Intentional native download cancellation")
            }
            Log.i(TAG, "PREPARED bundle=${input.bundleId} installedTree=${treeHash(File(root, "installations"))}")
            if (scenario == "pause-prepared") delay(30000)
            if (scenario == "stale-authority") synchronized(authorityLock) { revoked = true }
            val result = installer.commitPrepared(prepared, ::publish)
            return "scenario=$scenario bundle=${result.bundleId} entry=${result.entry} manifest=${result.manifestHash} files=${result.managedPaths.size} directory=${result.directory} installedTree=${treeHash(File(root, "installations"))}"
        } catch (error: Throwable) {
            val after = treeHash(File(root, "installations"))
            check(before == after) { "Failed preparation changed installed files" }
            Log.i(TAG, "PRESERVED_INSTALLED_FILES $after")
            throw error
        }
    }
    private fun request(value: JSONObject) = LynxArtifactRequest(value.getString("bundleId"), value.getString("fileUrl"), value.getString("fileHash"), value.opt("manifestFileHash").let { if (it == null || it == JSONObject.NULL) null else it as String })
    private fun fetchReceipt(url: String): JSONObject = OkHttpClient().newCall(Request.Builder().url(url).build()).execute().use { response -> check(response.isSuccessful); JSONObject(checkNotNull(response.body).string()) }
    private fun treeHash(root: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        if (root.exists()) root.walkTopDown().filter { it.isFile }.sortedBy { it.relativeTo(root).path }.forEach { file -> digest.update(file.relativeTo(root).path.toByteArray()); file.inputStream().use { input -> val bytes = ByteArray(8192); while (true) { val n = input.read(bytes); if (n < 0) break; digest.update(bytes, 0, n) } } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    companion object { private const val TAG = "HotUpdaterLynxG2" }
}
