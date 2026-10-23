package com.hotupdater

import android.util.Log
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The update check JavaScript leaves in main's key-value store for the check
 * after a crash: native knows no server of its own. A device whose JavaScript
 * never wrote one, such as one whose user hasn't accepted the app's privacy
 * terms yet, has none, so native sends no request.
 */
internal class RecoveryCheckConfig(
    val baseURL: String,
    val requestHeaders: Map<String, String>,
    val requestTimeoutMillis: Long,
    val updateStrategy: HotUpdaterUpdateStrategy,
) {
    /** The check on the current channel, as JavaScript's own check makes it. */
    fun toRequest(): NativeCheckRequest =
        NativeCheckRequest(
            baseURL = baseURL,
            updateStrategy = updateStrategy,
            requestHeaders = requestHeaders,
            requestTimeoutMillis = requestTimeoutMillis,
        )

    /** This record as JavaScript writes it, which [parse] reads back. */
    fun toJson(): String =
        JSONObject()
            .put("version", VERSION)
            .put("baseURL", baseURL)
            .put("requestHeaders", JSONObject(requestHeaders))
            .put("requestTimeoutMs", requestTimeoutMillis)
            .put("updateStrategy", updateStrategy.value)
            .toString()

    companion object {
        const val KEY = "hot-updater/recovery-check-config"
        private const val VERSION = 1
        private const val DEFAULT_TIMEOUT_MS = 5_000L

        /**
         * The record of a native check of main the server answered: its
         * headers as the request sent them ([effectiveHeaders]). Its channel
         * is left out, as JavaScript leaves it out: the check after a crash
         * uses the device's own.
         */
        fun of(request: NativeCheckRequest): RecoveryCheckConfig =
            RecoveryCheckConfig(
                request.baseURL,
                effectiveHeaders(request.requestHeaders),
                request.requestTimeoutMillis,
                request.updateStrategy,
            )

        /**
         * The record [value] holds, or null for a missing, unparsable,
         * other-version, or invalid one: no absolute HTTP(S) baseURL, an
         * unknown strategy, headers that aren't strings, or a timeout that
         * isn't a positive number. A record JavaScript writes always has
         * headers and a timeout; one without them takes the defaults.
         */
        fun parse(value: String?): RecoveryCheckConfig? {
            val json = value?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
            if (json.opt("version") != VERSION) return null
            val baseURL = json.opt("baseURL") as? String ?: return null
            if (runCatching { requireValidBaseURL(baseURL) }.isFailure) return null
            val strategy = json.opt("updateStrategy") as? String
            val updateStrategy = HotUpdaterUpdateStrategy.values().firstOrNull { it.value == strategy } ?: return null
            val headers = LinkedHashMap<String, String>()
            if (json.has("requestHeaders")) {
                val values = json.opt("requestHeaders") as? JSONObject ?: return null
                values.keys().forEach { name -> headers[name] = values.opt(name) as? String ?: return null }
            }
            val timeout =
                if (json.has("requestTimeoutMs")) {
                    val number = json.opt("requestTimeoutMs") as? Number ?: return null
                    number.toDouble().takeIf { it.isFinite() && it >= 1 }?.toLong() ?: return null
                } else {
                    DEFAULT_TIMEOUT_MS
                }
            return RecoveryCheckConfig(baseURL, headers, timeout, updateStrategy)
        }
    }
}

/**
 * Main's update check at the launch after a crash. Since first content
 * verifies a launch, a bundle whose own update flow crashes later can never
 * fetch its fix from JavaScript; native checks once, in the background, and
 * stages what it finds for the next launch, with no reload.
 *
 * A crash leaves its marker, which the next launch's preparation consumes:
 * [markPending] records that in the key-value store, so a launch that ends
 * before the check finishes, or shows no UI, leaves it for the next launch
 * that does. [startIfPending] then runs the check once per process, after the
 * launch is prepared and outside its locks, once a started activity shows UI.
 *
 * @param whenUiShown runs its action once this process shows UI, at once
 * when it already does; on the main thread
 * @param check checks with main's native checker, which queues the plugin
 * events JavaScript replays
 * @param background runs work off the thread React Native starts on
 */
internal class PostCrashUpdateCheck(
    private val getItem: (String) -> String?,
    private val setItem: (String, String?) -> Unit,
    private val whenUiShown: ((() -> Unit) -> Unit),
    private val check: suspend (NativeCheckRequest) -> HotUpdaterUpdate?,
    private val isRestartProcess: () -> Boolean,
    private val background: (Runnable) -> Unit = defaultBackground,
) {
    private val started = AtomicBoolean(false)

    /** Main's launch preparation consumed a crash marker that doesn't ask to roll back. */
    fun markPending() {
        setItem(PENDING_KEY, PENDING_VALUE)
    }

    /**
     * Main's launch preparation consumed a marker that asks to roll back: the
     * rollback settles that crash locally, and a check an earlier crash left
     * pending with it.
     */
    fun clearPending() {
        setItem(PENDING_KEY, null)
    }

    /**
     * Starts the check when a crash left it pending and this process hasn't
     * run it yet. Returns at once: reading the store is left to [background].
     */
    fun startIfPending() {
        if (started.get()) return
        background(
            Runnable {
                // Hot Updater's restart process only relaunches the app.
                if (isRestartProcess()) return@Runnable
                if (getItem(PENDING_KEY) != PENDING_VALUE) return@Runnable
                // Without a server there is nothing to ask, and the check
                // waits for a launch whose JavaScript left one.
                if (RecoveryCheckConfig.parse(getItem(RecoveryCheckConfig.KEY)) == null) {
                    log("skipped no config")
                    return@Runnable
                }
                // A launch without the flag must not use up the process's check.
                if (!started.compareAndSet(false, true)) return@Runnable
                whenUiShown { background(Runnable { run() }) }
            },
        )
    }

    private fun run() {
        // Read again: JavaScript may have saved a newer one while the app came up.
        val config = RecoveryCheckConfig.parse(getItem(RecoveryCheckConfig.KEY))
        if (config == null) {
            log("skipped no config")
            return
        }
        log("started")
        try {
            val update = runBlocking { check(config.toRequest()) }
            when {
                update == null -> log("no update")
                runBlocking { update.updateBundle() } -> log("staged ${update.id}")
                else -> log("skipped superseded")
            }
        } catch (error: Exception) {
            log("failed ${error.message ?: error.javaClass.simpleName}")
        } finally {
            // The attempt finished, whatever it found; a process that died
            // during it leaves the flag for the next launch to try again.
            setItem(PENDING_KEY, null)
        }
    }

    private fun log(status: String) {
        Log.i(TAG, "[HotUpdaterRecovery] Post-crash update check: $status")
    }

    companion object {
        const val PENDING_KEY = "hot-updater/recovery-check-pending"
        private const val PENDING_VALUE = "1"
        private const val TAG = "HotUpdaterRecovery"

        private val executor by lazy {
            Executors.newSingleThreadExecutor { task -> Thread(task, "HotUpdaterPostCrashCheck").apply { isDaemon = true } }
        }

        private val defaultBackground: (Runnable) -> Unit = { task -> executor.execute(task) }
    }
}
