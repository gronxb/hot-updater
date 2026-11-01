package com.hotupdater

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.lang.ref.WeakReference

private const val TAG = "HotUpdaterSandbox"
private const val HOST_ACTIVITY = "com.hotupdater.sandbox.HOST_ACTIVITY"

/** How often, and for how long, a waiting link checks whether a server answered the app. */
private const val SERVER_ANSWER_POLL_MS = 1_000L
private const val SERVER_ANSWER_ATTEMPTS = 600

/** The process's one coordinator: a switch outlives the activity that started it. */
internal object HotUpdaterSandbox {
    @Volatile
    private var coordinator: HotUpdaterSandboxCoordinator? = null
    private var screen: WeakReference<HotUpdaterSandboxActivity>? = null

    fun coordinator(context: Context): HotUpdaterSandboxCoordinator =
        coordinator ?: synchronized(this) {
            coordinator ?: HotUpdaterSandboxCoordinator(
                host = HotUpdaterSandboxLiveHost(context),
                store = HotUpdaterSandboxPreferences(context),
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                openApp = { switched, fixed -> open(context.applicationContext, switched, fixed) },
                log = { Log.i(TAG, it) },
            ).also { coordinator = it }
        }

    fun attach(activity: HotUpdaterSandboxActivity) {
        screen = WeakReference(activity)
    }

    fun detach(activity: HotUpdaterSandboxActivity) {
        if (screen?.get() === activity) screen = null
    }

    private fun open(
        context: Context,
        switched: Boolean,
        fixed: Boolean,
    ) {
        val activity = screen?.get()
        if (fixed || (switched && HotUpdaterSandboxProcess.hostStarted)) {
            restart(context, activity)
            return
        }
        activity?.openHost(switched)
    }

    /** The SDK's own restart, which comes back through the activity to the app. */
    private fun restart(
        context: Context,
        activity: Activity?,
    ) {
        Log.i(TAG, "restarting to apply the switch")
        val intent =
            Intent(context, HotUpdaterRestartActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(HotUpdaterRestartActivity.EXTRA_PACKAGE_NAME, context.packageName)
                .putExtra(HotUpdaterRestartActivity.EXTRA_TARGET_PID, Process.myPid())
        (activity ?: context).startActivity(intent)
    }

    /**
     * A link that waits for the app's first answered check is asked about as
     * soon as a server answered, while this process lives. After that, the
     * stored link waits for the next launch.
     */
    fun watchForServerAnswer(
        context: Context,
        attempts: Int = SERVER_ANSWER_ATTEMPTS,
    ) {
        val coordinator = coordinator(context)
        if (coordinator.state.phase !is HotUpdaterSandboxPhase.WaitingForServer || attempts <= 0) return
        Handler(Looper.getMainLooper()).postDelayed({
            if (HotUpdaterSandboxLiveHost(context).hasServerConfig()) {
                context.startActivity(
                    Intent(context, HotUpdaterSandboxActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        .putExtra(HotUpdaterSandboxActivity.EXTRA_OVER_APP, true),
                )
            } else {
                watchForServerAnswer(context, attempts - 1)
            }
        }, SERVER_ANSWER_POLL_MS)
    }
}

/**
 * Takes the launcher entry and the sandbox's links, so the app's JavaScript waits
 * until `ReactActivity` runs. Anything else addressed to the app passes through.
 */
class HotUpdaterSandboxActivity : Activity() {
    internal companion object {
        /** The sandbox's own start over a running app, which only it can send. */
        const val EXTRA_OVER_APP = "com.hotupdater.sandbox.OVER_APP"
    }

    private var stopObserving: (() -> Unit)? = null
    private var screen: HotUpdaterSandboxScreen? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent, restored = savedInstanceState != null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent, restored = false)
    }

    private fun handle(
        intent: Intent,
        restored: Boolean,
    ) {
        val decision =
            HotUpdaterSandboxStart.decide(
                HotUpdaterSandboxStartFacts(
                    action = intent.action,
                    dataScheme = intent.scheme,
                    hasData = intent.data != null,
                    categories = intent.categories.orEmpty(),
                    hasExtras = intent.extras?.isEmpty == false && !intent.hasExtra(EXTRA_OVER_APP),
                    hasClipData = intent.clipData != null,
                    flags = intent.flags,
                    restored = restored,
                ),
            )
        Log.i(TAG, "start: $decision flags=0x${Integer.toHexString(intent.flags)} action=${intent.action}")
        if (decision == HotUpdaterSandboxStartDecision.OPEN_HOST && !intent.hasExtra(EXTRA_OVER_APP)) {
            startHost(intent)
            return
        }
        // A browser may start a link in its own task; the sandbox's screen has its own.
        if (decision == HotUpdaterSandboxStartDecision.SHOW_LINK && intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK == 0) {
            startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        val coordinator = HotUpdaterSandbox.coordinator(this)
        HotUpdaterSandbox.attach(this)
        if (screen == null) {
            val shown = HotUpdaterSandboxScreen(this, coordinator)
            screen = shown
            setContentView(shown.view)
            stopObserving = coordinator.observe(shown::render)
        }
        if (decision == HotUpdaterSandboxStartDecision.SHOW_LINK) {
            intent.dataString?.let(coordinator::receiveLink)
        }
        coordinator.refresh()
    }

    /** Whether the app is underneath: read from this process, never from saved state. */
    internal val isOverApp: Boolean
        get() = HotUpdaterSandboxProcess.hostActivities > 0

    /** The screen closes itself over the app once nothing is left to answer. */
    internal fun closeOverApp() {
        if (isOverApp) finish()
    }

    internal fun openHost(switched: Boolean) {
        HotUpdaterSandbox.watchForServerAnswer(this)
        if (isOverApp && !switched) {
            finish()
            return
        }
        val launcher = intent.takeUnless { HotUpdaterSandboxLink.isSandboxScheme(it.scheme) || it.hasExtra(EXTRA_OVER_APP) }
        startHost(launcher ?: Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))
    }

    /** A copy of what started this activity, for the app's: its contract with whoever sent it. */
    private fun startHost(incoming: Intent) {
        val host =
            packageManager
                .getActivityInfo(componentName, PackageManager.GET_META_DATA)
                .metaData
                ?.getString(HOST_ACTIVITY)
        if (host == null) {
            Log.e(TAG, "no host activity in the manifest")
            finish()
            return
        }
        val copy =
            Intent(incoming)
                .setComponent(ComponentName(packageName, host))
                .setFlags(HotUpdaterSandboxStart.hostFlags(incoming.flags))
        copy.selector = null
        startActivity(copy)
        overridePendingTransition(0, 0)
        finish()
    }

    override fun onDestroy() {
        stopObserving?.invoke()
        stopObserving = null
        HotUpdaterSandbox.detach(this)
        super.onDestroy()
    }
}
