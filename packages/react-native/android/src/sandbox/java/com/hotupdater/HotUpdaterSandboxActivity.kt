package com.hotupdater

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Process
import android.util.Log
import android.view.Choreographer
import android.view.ViewTreeObserver
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import com.facebook.react.ReactActivity
import com.facebook.react.ReactDelegate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.lang.ref.WeakReference

private const val TAG = "HotUpdaterSandbox"
private const val HOST_ACTIVITY = "com.hotupdater.sandbox.HOST_ACTIVITY"

/** The process's one coordinator: a switch outlives the activity that started it. */
internal object HotUpdaterSandbox {
    @Volatile
    private var coordinator: HotUpdaterSandboxCoordinator? = null
    private var screen: WeakReference<HotUpdaterSandboxActivity>? = null

    @Volatile
    private var devServer: HotUpdaterSandboxLiveDevServer? = null

    fun devServer(context: Context): HotUpdaterSandboxDevServer =
        devServer ?: synchronized(this) {
            devServer ?: HotUpdaterSandboxLiveDevServer(
                context = context,
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                onLeavingNormalLaunch = {
                    HotUpdaterSandboxDev.clearNormalLaunchStarted(HotUpdater.getInstance(context.applicationContext).getRunningBundleId())
                },
            ).also { devServer = it }
        }

    fun coordinator(context: Context): HotUpdaterSandboxCoordinator =
        coordinator ?: synchronized(this) {
            coordinator ?: HotUpdaterSandboxCoordinator(
                host = HotUpdaterSandboxLiveHost(context),
                store = HotUpdaterSandboxPreferences(context),
                shelf = HotUpdaterSandboxDev.shelf(context),
                scope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
                openApp = { switched, fixed -> open(context.applicationContext, switched, fixed) },
                log = { Log.i(TAG, it) },
                isOwnScheme = { HotUpdaterSandboxLink.isOwnScheme(it, HotUpdaterSandboxLink.ownScheme(context)) },
                onServerAnswer = { askOverApp(context.applicationContext) },
            ).also { coordinator = it }
        }

    /** Whether the screen in front can start the app under itself. */
    fun canStartHostUnderScreen(): Boolean = screen?.get()?.canStartHostUnderScreen() == true

    /** Starts the app under the screen in front, which stays on top. */
    fun startHostUnderScreen() {
        screen?.get()?.startHostUnderScreen()
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
     * A link that waited for the app's first answered check asks now, over the
     * app when no screen is up. After this process, the stored link waits for
     * the next launch.
     */
    private fun askOverApp(context: Context) {
        if (screen?.get() != null || coordinator?.state?.phase !is HotUpdaterSandboxPhase.Confirming) return
        context.startActivity(
            Intent(context, HotUpdaterSandboxActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(HotUpdaterSandboxActivity.EXTRA_OVER_APP, true),
        )
    }
}

/**
 * Takes the launcher entry and the sandbox's links, so the app's JavaScript waits
 * until `ReactActivity` runs. Anything else addressed to the app passes through.
 */
class HotUpdaterSandboxActivity : ComponentActivity() {
    internal companion object {
        /** The sandbox's own start over a running app, which only it can send. */
        const val EXTRA_OVER_APP = "com.hotupdater.sandbox.OVER_APP"

        /** The app's activity, started under the screen, brings the screen back on top. */
        const val EXTRA_COVER = "com.hotupdater.sandbox.COVER"
        private const val STATE_COVERS_HOST = "com.hotupdater.sandbox.COVERS_HOST"
    }

    private var stopObserving: (() -> Unit)? = null
    private var screen: HotUpdaterSandboxScreen? = null

    /**
     * This screen started the app under itself, and nobody has seen it: the screen
     * stays the first screen. Kept across recreation, where the task may still hold
     * the app's activity with no process behind it.
     */
    private var coversHost = false

    /** Back on a screen over the app it started leaves, as on the first screen: it never shows the app. */
    private val leaveOnBack =
        object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        coversHost = savedInstanceState?.getBoolean(STATE_COVERS_HOST) == true || intent.hasExtra(EXTRA_COVER)
        leaveOnBack.isEnabled = coversHost
        onBackPressedDispatcher.addCallback(this, leaveOnBack)
        handle(intent, savedInstanceState)
    }

    override fun onPause() {
        super.onPause()
        // Out of sight with the app it covers: the app's React Native pauses as it would.
        if (coversHost && !isFinishing) coveredReactDelegate()?.onHostPause()
    }

    override fun onResume() {
        super.onResume()
        // The app under the screen runs as the app in front would, timers included:
        // its own pause stopped them, and its update check resolves through one.
        if (coversHost) coveredReactDelegate()?.onHostResume()
        // Back in front in this process: a stored session's relaunch still pending didn't happen.
        if (screen != null) HotUpdaterSandbox.coordinator(this).resumed()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Back on top of the app it started: this screen keeps what started it.
        if (intent.hasExtra(EXTRA_COVER)) {
            Log.i(TAG, "covering the app started under the screen")
            return
        }
        setIntent(intent)
        handle(intent, null)
    }

    private fun handle(
        intent: Intent,
        saved: Bundle?,
    ) {
        val restored = saved != null
        val decision =
            HotUpdaterSandboxStart.decide(
                HotUpdaterSandboxStartFacts(
                    action = intent.action,
                    dataScheme = intent.scheme,
                    hasData = intent.data != null,
                    categories = intent.categories.orEmpty(),
                    hasExtras = intent.extras?.isEmpty == false && !intent.hasExtra(EXTRA_OVER_APP) && !intent.hasExtra(EXTRA_COVER),
                    hasClipData = intent.clipData != null,
                    flags = intent.flags,
                    restored = restored,
                    ownScheme = HotUpdaterSandboxLink.ownScheme(this),
                ),
            )
        Log.i(TAG, "start: $decision flags=0x${Integer.toHexString(intent.flags)} action=${intent.action}")
        if (decision == HotUpdaterSandboxStartDecision.OPEN_HOST && !intent.hasExtra(EXTRA_OVER_APP) && !intent.hasExtra(EXTRA_COVER)) {
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
            // Drawn under the system bars, with the keyboard's insets for the screen to avoid.
            enableEdgeToEdge()
            @Suppress("DEPRECATION")
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            val shown = HotUpdaterSandboxScreen(this, coordinator, HotUpdaterSandbox.devServer(this), saved)
            screen = shown
            setContentView(shown.view)
            watchFirstFrame()
            stopObserving = coordinator.observe(shown::render)
        }
        if (decision == HotUpdaterSandboxStartDecision.SHOW_LINK) {
            intent.dataString?.let(coordinator::receiveLink)
        }
        coordinator.refresh()
    }

    /** Whether the app's activity is underneath: read from this process, never from saved state. */
    private val hostBeneath: Boolean
        get() = HotUpdaterSandboxProcess.hostActivities > 0

    /** Whether the screen is over an app a person has seen: what the screen says and offers. */
    internal val isOverApp: Boolean
        get() = hostBeneath && !coversHost

    /**
     * Whether the app can start under this screen: its activity is known, and the
     * task holds no activity of it that a restore left with no process behind it.
     */
    internal fun canStartHostUnderScreen(): Boolean = !isFinishing && hostComponent() != null && !(coversHost && !hostBeneath)

    /**
     * Starts the app's activity under this screen: once it's created, it brings this
     * screen back on top before its first frame, and its JavaScript checks for updates.
     */
    internal fun startHostUnderScreen() {
        // Before the screen's first frame, the app's would be what shows.
        if (!hasDrawn) {
            startWhenDrawn = true
            return
        }
        startWhenDrawn = false
        val host = hostComponent() ?: return
        coversHost = true
        leaveOnBack.isEnabled = true
        HotUpdaterSandboxProcess.pendingCover = HotUpdaterSandboxCover(host, taskId, this)
        try {
            startActivity(hostIntent(launcherIntent(), host).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION))
            overridePendingTransition(0, 0)
        } catch (error: RuntimeException) {
            Log.e(TAG, "the app couldn't start under the screen", error)
            HotUpdaterSandboxProcess.dropCover(this)
            coversHost = false
            leaveOnBack.isEnabled = false
        }
    }

    /** Whether this screen drew a frame, so it's what the display shows. */
    private var hasDrawn = false

    /** A start under the screen asked for before its first frame. */
    private var startWhenDrawn = false

    private fun watchFirstFrame() {
        val decor = window.decorView
        val listener =
            object : ViewTreeObserver.OnDrawListener {
                override fun onDraw() {
                    decor.post {
                        decor.viewTreeObserver.removeOnDrawListener(this)
                        // The frame drawn now is on the display by the next one.
                        Choreographer.getInstance().postFrameCallback {
                            hasDrawn = true
                            if (startWhenDrawn && !isFinishing) startHostUnderScreen()
                        }
                    }
                }
            }
        decor.viewTreeObserver.addOnDrawListener(listener)
    }

    /** The covered app's React Native, to keep its lifecycle with the screen's. */
    private fun coveredReactDelegate(): ReactDelegate? =
        (HotUpdaterSandboxProcess.coveredHost?.get() as? ReactActivity)?.takeUnless { it.isFinishing }?.reactDelegate

    /** Brings this screen back over [host], which this screen just started. */
    internal fun coverHost(host: Activity) {
        Log.i(TAG, "the app started under the screen: covering it")
        HotUpdaterSandboxProcess.coveredHost = WeakReference(host)
        host.startActivity(
            Intent(host, HotUpdaterSandboxActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(EXTRA_COVER, true),
        )
        host.overridePendingTransition(0, 0)
    }

    /** The screen closes itself over the app once nothing is left to answer. */
    internal fun closeOverApp() {
        if (isOverApp) finish()
    }

    internal fun openHost(switched: Boolean) {
        startWhenDrawn = false
        HotUpdaterSandboxProcess.dropCover(this)
        // The app is beneath: running, or one this screen started that a restore
        // left with no process, which starts now on what's selected.
        if ((hostBeneath && !switched) || (coversHost && !hostBeneath)) {
            finish()
            return
        }
        startHost(launcherIntent())
    }

    /** What the app's activity gets from a screen: what started it, never a sandbox link. */
    private fun launcherIntent(): Intent =
        intent.takeUnless {
            HotUpdaterSandboxLink.isOwnScheme(it.scheme, HotUpdaterSandboxLink.ownScheme(this)) || it.hasExtra(EXTRA_OVER_APP)
        } ?: Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)

    /** The app's activity, as the manifest names it. */
    private fun hostComponent(): ComponentName? =
        packageManager
            .getActivityInfo(componentName, PackageManager.GET_META_DATA)
            .metaData
            ?.getString(HOST_ACTIVITY)
            ?.let { ComponentName(packageName, it) }

    private fun hostIntent(
        incoming: Intent,
        host: ComponentName,
    ): Intent {
        val copy =
            Intent(incoming)
                .setComponent(host)
                .setFlags(HotUpdaterSandboxStart.hostFlags(incoming.flags))
        copy.selector = null
        return copy
    }

    /** A copy of what started this activity, for the app's: its contract with whoever sent it. */
    private fun startHost(incoming: Intent) {
        val host = hostComponent()
        if (host == null) {
            Log.e(TAG, "no host activity in the manifest")
            finish()
            return
        }
        startActivity(hostIntent(incoming, host))
        overridePendingTransition(0, 0)
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_COVERS_HOST, coversHost)
        screen?.save(outState)
    }

    override fun onDestroy() {
        // Back over the app: a person saw the screen and moved on. A start that
        // passed through to the app showed nothing, so what it left stays to tell.
        if (isFinishing && screen != null && isOverApp) HotUpdaterSandbox.coordinator(this).acknowledgeLastLaunch()
        stopObserving?.invoke()
        stopObserving = null
        HotUpdaterSandboxProcess.dropCover(this)
        HotUpdaterSandbox.detach(this)
        super.onDestroy()
    }
}
