package com.hotupdater

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.NetworkSecurityPolicy
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

private const val TAG = "HotUpdaterSandboxDev"
private const val DEFAULT_PORT = 8081
private const val MAX_RECENT_HOSTS = 5
private const val RECENT_HOSTS = "devServerRecentHosts"

/** A host as a person typed it: `host:port`, or with its scheme. Null when it isn't one. */
internal object HotUpdaterSandboxDevHost {
    fun normalize(entry: String): String? {
        val text = entry.trim().trimEnd('/')
        if (text.isEmpty() || text.any { it.isWhitespace() }) return null
        val parts = text.split("://", limit = 2)
        val scheme = if (parts.size == 2) parts[0].lowercase() else "http"
        if (scheme != "http" && scheme != "https") return null
        val authority = parts.last()
        if (authority.isEmpty() || authority.contains('/') || authority.contains('?')) return null
        return if (authority.substringAfterLast(']').contains(':')) {
            "$scheme://$authority"
        } else {
            "$scheme://$authority:$DEFAULT_PORT"
        }
    }

    /** The name an http(s) URL's host has, for the network security policy. */
    fun hostname(url: String): String = url.substringAfter("://").substringBeforeLast(':').trim('[', ']')

    /** The defaults of this device, then what was used here, newest first. */
    fun listed(
        isEmulator: Boolean,
        recent: List<String>,
    ): List<String> {
        val defaults =
            if (isEmulator) {
                listOf("http://10.0.2.2:$DEFAULT_PORT", "http://localhost:$DEFAULT_PORT")
            } else {
                listOf("http://localhost:$DEFAULT_PORT")
            }
        return (recent + defaults).distinct()
    }

    /** The name the screen shows, without the default scheme. */
    fun display(url: String): String = url.removePrefix("http://")
}

/**
 * Fetches one `dev=false` bundle and its assets from a dev server into a new
 * session directory, in the layout React Native reads beside a bundle file:
 * the names of `assetPathUtils.getResourceIdentifier` and
 * `getAndroidResourceFolderName`. Throws with what a person can act on.
 */
internal class HotUpdaterSandboxDevFetcher(
    private val client: OkHttpClient =
        OkHttpClient
            .Builder()
            .connectTimeout(
                5,
                TimeUnit.SECONDS,
            ).readTimeout(120, TimeUnit.SECONDS)
            .build(),
) {
    private val query = "platform=android&dev=false&minify=false"

    fun fetch(
        host: String,
        session: File,
        bundleName: String,
    ) {
        session.mkdirs()
        try {
            val entry = downloadBundle(host, File(session, bundleName))
            val assets =
                try {
                    JSONArray(text("$host/$entry.assets?$query", notFound = NO_ASSET_LIST))
                } catch (error: org.json.JSONException) {
                    throw IOException(NO_ASSET_LIST)
                }
            for (index in 0 until assets.length()) {
                downloadAsset(host, assets.getJSONObject(index), session)
            }
        } catch (error: Exception) {
            session.deleteRecursively()
            throw error
        }
    }

    /**
     * Downloads the JavaScript, and returns the entry that served it: `index`, or
     * what Expo's manifest names, since its server resolves from a workspace's root.
     */
    private fun downloadBundle(
        host: String,
        target: File,
    ): String {
        if (tryDownload("$host/$DEFAULT_ENTRY.bundle?$query", target)) return DEFAULT_ENTRY
        val manifest =
            client
                .newCall(
                    Request
                        .Builder()
                        .url(host)
                        .header("expo-platform", "android")
                        .header("accept", "application/expo+json,application/json")
                        .build(),
                ).execute()
                .use { response -> if (response.isSuccessful) response.body?.string() else null }
        val entry =
            manifest?.let(::entryOfManifest)
                ?: throw IOException("$host has no /$DEFAULT_ENTRY.bundle.")
        download("$host/$entry.bundle?$query", target)
        return entry
    }

    private fun downloadAsset(
        host: String,
        asset: JSONObject,
        session: File,
    ) {
        val type = asset.getString("type")
        val name = asset.getString("name")
        val hash = asset.getString("hash")
        val location = asset.getString("httpServerLocation")
        val scales = asset.getJSONArray("scales")
        val base = resourceName(location, name)
        for (index in 0 until scales.length()) {
            val scale = scales.getDouble(index)
            val folder = if (type in DRAWABLE_TYPES) "drawable-${scaleFolder(scale)}" else "raw"
            val suffix = if (scale == 1.0) "" else "@${scale.toString().removeSuffix(".0")}x"
            val separator = if (location.contains("?")) "&" else "?"
            download("$host$location/$name$suffix.$type${separator}platform=android&hash=$hash", File(session, "$folder/$base.$type"))
        }
    }

    private fun request(url: String) = client.newCall(Request.Builder().url(url).build()).execute()

    private fun text(
        url: String,
        notFound: String,
    ): String =
        request(url).use { response ->
            if (response.code == 404) throw IOException(notFound)
            if (!response.isSuccessful) throw IOException("$url answered ${response.code}.")
            response.body?.string().orEmpty()
        }

    private fun download(
        url: String,
        target: File,
    ) {
        if (!tryDownload(url, target)) throw IOException("$url answered 404.")
    }

    /** False on a 404, which says the entry isn't there; any other failure throws. */
    private fun tryDownload(
        url: String,
        target: File,
    ): Boolean =
        request(url).use { response ->
            if (response.code == 404) return@use false
            if (!response.isSuccessful) throw IOException("$url answered ${response.code}.")
            target.parentFile?.mkdirs()
            val body = response.body ?: throw IOException("$url answered with nothing.")
            body.byteStream().use { input -> target.outputStream().use { input.copyTo(it) } }
            true
        }

    companion object {
        private val DRAWABLE_TYPES = setOf("gif", "jpeg", "jpg", "ktx", "png", "webp", "xml")

        const val DEFAULT_ENTRY = "index"

        /** The entry an Expo manifest's `launchAsset` names, or null. */
        fun entryOfManifest(manifest: String): String? =
            runCatching {
                val url = JSONObject(manifest).getJSONObject("launchAsset").getString("url")
                url
                    .substringBefore('?')
                    .substringAfter("://")
                    .substringAfter('/')
                    .removeSuffix(".bundle")
                    .takeIf { it.isNotEmpty() }
            }.getOrNull()

        /** Re.Pack's dev server, for one. */
        const val NO_ASSET_LIST = "This dev server has no /index.assets, which Android needs for its assets, and Metro has."

        fun resourceName(
            location: String,
            name: String,
        ): String =
            "${location.removePrefix("/")}/$name"
                .lowercase()
                .replace('/', '_')
                .replace(Regex("[^a-z0-9_]"), "")
                .replace(Regex("^(?:assets|assetsunstable_path)_"), "")

        fun scaleFolder(scale: Double): String =
            when (scale) {
                0.75 -> "ldpi"
                1.0 -> "mdpi"
                1.5 -> "hdpi"
                2.0 -> "xhdpi"
                3.0 -> "xxhdpi"
                4.0 -> "xxxhdpi"
                else -> throw IOException("No Android resource folder for scale $scale.")
            }
    }
}

/**
 * The one owner of connecting and reloading: connections run one at a time, the
 * running session's files stay until its process exits, and success replaces
 * this process, so a launch always starts from a settled state.
 */
internal class HotUpdaterSandboxLiveDevServer(
    context: Context,
    private val scope: CoroutineScope,
    private val onLeavingNormalLaunch: () -> Unit = {},
) : HotUpdaterSandboxDevServer {
    private val context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val connections = Mutex()
    private val preferences = this.context.getSharedPreferences("hot_updater_sandbox", Context.MODE_PRIVATE)
    private val answered = HashMap<String, Boolean>()
    private val probeClient = OkHttpClient.Builder().callTimeout(1, TimeUnit.SECONDS).build()

    override val isRunningDevServer: Boolean
        get() = HotUpdaterSandboxDev.session(context) != null

    override val runningDevServerHost: String?
        get() = HotUpdaterSandboxDev.session(context)?.host?.let(HotUpdaterSandboxDevHost::display)

    override val devServerHosts: List<HotUpdaterSandboxDevServerHost>
        get() =
            hostUrls().map { url ->
                HotUpdaterSandboxDevServerHost(HotUpdaterSandboxDevHost.display(url), answered[url])
            }

    override var lastDevServerError: String? = null
        private set

    override var onDevServerChange: (() -> Unit)? = null
        set(value) {
            field = value
            if (value != null) probe()
        }

    private fun hostUrls(): List<String> =
        HotUpdaterSandboxDevHost.listed(
            isEmulator = Build.FINGERPRINT.contains("generic") || Build.HARDWARE.contains("ranchu"),
            recent = recentHosts(),
        )

    private fun recentHosts(): List<String> =
        runCatching {
            val stored = JSONArray(preferences.getString(RECENT_HOSTS, "[]"))
            (0 until stored.length()).map(stored::getString)
        }.getOrDefault(emptyList())

    private fun remember(host: String) {
        val recent = (listOf(host) + recentHosts()).distinct().take(MAX_RECENT_HOSTS)
        preferences.edit().putString(RECENT_HOSTS, JSONArray(recent).toString()).commit()
    }

    /** One `GET /status` per listed host, with a second to answer. */
    private fun probe() {
        scope.launch {
            val urls = hostUrls()
            val results =
                withContext(Dispatchers.IO) {
                    urls.map { url -> async { url to answers(url) } }.awaitAll()
                }
            answered.clear()
            answered.putAll(results)
            onDevServerChange?.invoke()
        }
    }

    private fun answers(host: String): Boolean =
        runCatching {
            probeClient.newCall(Request.Builder().url("$host/status").build()).execute().use { response ->
                response.isSuccessful &&
                    response.body
                        ?.string()
                        .orEmpty()
                        .contains("packager-status:running")
            }
        }.getOrDefault(false)

    override fun connect(
        host: String,
        completion: (String?) -> Unit,
    ) {
        val url = HotUpdaterSandboxDevHost.normalize(host)
        if (url == null) {
            completion("\"$host\" isn't a dev server address. Enter one like 192.168.0.2:8081.")
            return
        }
        scope.launch {
            connections.withLock {
                completion(withContext(Dispatchers.IO) { fetchAndRelaunch(url) })
            }
        }
    }

    /** A failure as a message, or null once the relaunch started. */
    private fun fetchAndRelaunch(url: String): String? {
        val policy =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && url.startsWith("http://")) {
                NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(HotUpdaterSandboxDevHost.hostname(url))
            } else {
                true
            }
        if (!policy) {
            return "This app's network security config blocks http to ${HotUpdaterSandboxDevHost.hostname(url)}. " +
                "Allow cleartext for that host in the config, or serve the dev server over https."
        }
        val files = HotUpdaterSandboxDev.filesOf(context)
        val id = UUID.randomUUID().toString()
        try {
            HotUpdaterSandboxDevFetcher().fetch(url, files.session(id), HotUpdaterSandboxDevFiles.BUNDLE)
        } catch (error: Exception) {
            Log.w(TAG, "connect to $url failed", error)
            return "Couldn't load JavaScript from ${HotUpdaterSandboxDevHost.display(url)}. ${error.message ?: error} " +
                "Check that the dev server runs and this device can reach it."
        }
        remember(url)
        if (!isRunningDevServer) onLeavingNormalLaunch()
        HotUpdaterSandboxDev.startRelaunch(context, HotUpdaterSandboxRelaunch.Dev(id, url))
        return null
    }

    /** Fetches the running host's JavaScript again. The session goes on if it can't. */
    override fun reloadDevServer() {
        val host = HotUpdaterSandboxDev.session(context)?.host ?: return
        connect(host) { failure ->
            lastDevServerError = failure
            main.post { onDevServerChange?.invoke() }
        }
    }

    /** Only here does a dev session end, other than with its process. */
    override fun exitDevServer() {
        if (!isRunningDevServer) return
        HotUpdaterSandboxDev.startRelaunch(context, HotUpdaterSandboxRelaunch.FirstScreen)
    }
}
