package com.hotupdater.lynxexample

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.TextView
import com.lynx.tasm.LynxError
import com.lynx.tasm.LynxView
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.LynxBooleanOption
import com.lynx.tasm.LynxViewClient
import com.tiktok.sparkling.SparklingContext
import com.tiktok.sparkling.hybridkit.lynx.SimpleLynxKitView
import com.tiktok.sparkling.hybridkit.base.HybridKitType
import com.tiktok.sparkling.hybridkit.scheme.HybridSchemeParam
import org.json.JSONObject
import java.io.File
import java.util.UUID

class SpikeActivity : Activity() {
    private var lynxView: LynxView? = null
    private var attempt: LaunchAttempt? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try { openPrimary() } catch (error: Exception) {
            Log.e("HotUpdaterLynxG1", "pre-execution-rejection ${error.message}", error)
            setContentView(TextView(this).apply { text = "G1 rejected before execution: ${error.message}" })
        }
    }

    private fun copyEmbedded(path: String, target: File) {
        val children = assets.list(path).orEmpty()
        if (children.isEmpty()) { target.parentFile?.mkdirs(); assets.open(path).use { input -> target.outputStream().use { input.copyTo(it) } } }
        else { target.mkdirs(); children.forEach { copyEmbedded("$path/$it", File(target, it)) } }
    }

    private fun openPrimary() {
        val framework = intent.getStringExtra("framework") ?: "react"
        require(framework in listOf("react", "vue", "octane")) { "Unknown framework" }
        if (intent.getBooleanExtra("noPrimary", false)) {
            setContentView(TextView(this).apply { text = "Primary context intentionally unopened" })
            Log.i("HotUpdaterLynxG1", "no-primary-context")
            return
        }
        require(!intent.getBooleanExtra("secondary", false)) { "Secondary context must wait for the designated primary" }
        check(!SpikeRegistry.primaryStarted) { "Primary context already designated in this process; restart required" }
        val journal = StartupState(applicationContext)
        if (!SpikeRegistry.recovered) { journal.recoverPreviousProcess(); SpikeRegistry.recovered = true }
        val selection = journal.select(intent, framework)
        require(!journal.isCompatibilityRejected(selection)) { "Native compatibility mismatch (cached)" }
        val release = selection.slot
        val embeddedId = JSONObject(assets.open("$framework/A/hot-updater-lynx.json").bufferedReader().use { it.readText() }).getString("bundleId")
        require(embeddedId.matches(Regex("[0-9a-fA-F-]+"))) { "Invalid embedded identity" }
        val root = if (release == "A") File(filesDir, "embedded/$framework/$embeddedId").also {
            if (!it.exists()) copyEmbedded("$framework/A", it)
        } else File(filesDir, "releases/$framework/$release").also {
            if (!it.exists()) {
                val staged = File(filesDir, "staged/$framework/$release")
                require(staged.isDirectory) { "No manually staged candidate" }
                staged.copyRecursively(it, overwrite = false)
            }
        }
        val manifestBytes = File(root, "manifest.json").readBytes()
        val trustedManifestHash = if (release == "A") sha256(assets.open("$framework/A/manifest.json").use { it.readBytes() })
            else requireNotNull(selection.manifestFileHash) { "Missing trusted manifest digest" }
        require(sha256(manifestBytes) == trustedManifestHash) { "Manifest digest mismatch" }
        val metadata = JSONObject(File(root, "hot-updater-lynx.json").readText())
        val schemaVersion = metadata.opt("schemaVersion")
        require(schemaVersion is Number && schemaVersion.toDouble() == 1.0) { "Unsupported metadata schema" }
        for (field in listOf("bundleId", "platform", "entry", "runtimeId")) {
            val value = metadata.opt(field)
            require(value is String && value.isNotBlank()) { "Invalid metadata field: $field" }
        }
        require(metadata.getString("platform") == "android") { "Platform mismatch" }
        if (release != "A") require(metadata.getString("bundleId") == selection.bundleId) { "Candidate bundle mismatch" }
        val manifest = JSONObject(String(manifestBytes))
        require(manifest.getString("bundleId") == metadata.getString("bundleId")) { "Bundle identity mismatch" }
        val manifestAssets = manifest.getJSONObject("assets")
        val resources = ReleaseResources(root, "$framework-$release", manifestAssets.keys().asSequence().toSet())
        require(manifestAssets.has("hot-updater-lynx.json") && manifestAssets.has(metadata.getString("entry"))) { "Metadata or entry absent from manifest" }
        manifestAssets.keys().forEach { path ->
            val actual = sha256(resources.resolve("asset:///$path", "verify").readBytes())
            require(actual == manifestAssets.getJSONObject(path).getString("fileHash")) { "Manifest hash mismatch: $path" }
        }
        if (metadata.getString("runtimeId") != BuildConfig.LYNX_COMPATIBILITY_ID) {
            journal.rejectCompatibility(selection)
            error("Native compatibility mismatch")
        }
        val releaseId = selection.releaseId
        val data = mapOf("platform" to "android", "bundleId" to metadata.getString("bundleId"), "releaseId" to releaseId,
            "runtimeId" to BuildConfig.LYNX_COMPATIBILITY_ID, "attemptId" to UUID.randomUUID().toString(), "contextId" to UUID.randomUUID().toString())
        val primary = LaunchAttempt(data, resources, manifestAssets.has("assets/probe.ttf"), journal, selection, intent.getLongExtra("readyDelayMs", 0L).coerceIn(0L, 30000L))
        resources.onFontLoaded = { Handler(Looper.getMainLooper()).post { primary.confirmIfReady() } }
        resources.onFailure = { message -> Handler(Looper.getMainLooper()).post {
            if (!primary.confirmed) { primary.failed = true; journal.fail(data["attemptId"].toString(), message) }
        } }
        attempt = primary
        val processResources = SpikeRegistry.resources
        require(processResources == null || processResources.root.canonicalFile == root.canonicalFile) { "Process release already pinned; restart required" }
        SpikeRegistry.resources = resources
        SpikeRegistry.primaryStarted = true
        val entry = "hot-updater:///" + metadata.getString("entry")
        val scheme = HybridSchemeParam(engineType = HybridKitType.LYNX, bundle = entry)
        val sparkling = SparklingContext().apply {
            hybridSchemeParam = scheme
            this.scheme = "hybrid://lynxview_page?bundle=$entry"
            containerId = data["contextId"].toString()
        }
        val builder = LynxViewBuilder().apply {
            setTemplateProvider(ReleaseTemplateProvider())
            setMediaResourceFetcher(resources.media)
            setFontLoader(resources.font)
            setGenericResourceFetcher(resources.generic)
            setTemplateResourceFetcher(resources.template)
            setEnableGenericResourceFetcher(LynxBooleanOption.TRUE)
        }
        val kit = SimpleLynxKitView(this, sparkling, builder, null, null)
        (requireNotNull(kit.realView()) as LynxView).let { view ->
                lynxView = view
                SpikeRegistry.attempts[view.lynxContext] = primary
                view.addLynxViewClient(object : LynxViewClient() {
                    override fun onFirstScreen() {
                        Log.i("HotUpdaterLynxG1", "native-first-screen $data")
                        primary.observedContent = true
                        primary.confirmIfReady()
                    }
                    override fun onReceivedError(error: LynxError) {
                        Log.e("HotUpdaterLynxG1", "lynx-error fatal=${error.isFatal} code=${error.errorCode} message=${error.msg}")
                        if (error.isFatal && !primary.confirmed) {
                            primary.failed = true
                            journal.fail(data["attemptId"].toString(), error.msg)
                        }
                    }
                    override fun onLoadFailed(message: String) {
                        primary.failed = true
                        journal.fail(data["attemptId"].toString(), message)
                        Log.e("HotUpdaterLynxG1", "load-failed $message")
                    }
                })
        }
        setContentView(kit.realView())
        val newAttempt = journal.begin(selection, data)
        Log.i("HotUpdaterLynxG1", "${if (newAttempt) "attempt" else "confirmed-resume"}-before-evaluation $data")
        kit.load()
    }

    override fun onDestroy() {
        attempt?.let { it.live = false; Log.i("HotUpdaterLynxG1", "context-destroyed attempt=${it.data["attemptId"]}") }
        lynxView?.let { SpikeRegistry.attempts.remove(it.lynxContext); it.destroy() }
        super.onDestroy()
    }
}
