package com.hotupdater.lynx

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.LynxViewClient
import com.lynx.tasm.service.ILynxImageService
import com.lynx.tasm.service.LynxServiceCenter
import java.util.UUID
import org.json.JSONObject

/** Owns native containers, their verified resources, and whole-generation replacement. */
class HotUpdaterLynxHost internal constructor(
    private val runtimeHost: LynxRuntimeHost,
    launchConfiguration: Map<String, String>,
    private val onError: (Throwable) -> Unit,
    private val createRuntime: (Context, LynxLaunchSession, Map<String, String>, () -> Unit) -> ManagedLynxRuntime,
) : AutoCloseable {
    constructor(
        context: Context,
        configuration: LynxHostConfiguration,
        launchConfiguration: Map<String, String> = emptyMap(),
        onError: (Throwable) -> Unit = { android.util.Log.e("HotUpdaterLynx", "Native host closed", it) },
    ) : this(LynxRuntimeHost.get(context, configuration), launchConfiguration, onError, ::LynxViewRuntime) {
        check(LynxEnv.inst().isNativeLibraryLoaded) { "Initialize Lynx before constructing its native host" }
        check(LynxServiceCenter.inst().getService(ILynxImageService::class.java) != null) {
            "Initialize the Lynx image service before constructing its native host"
        }
    }

    private class Mount(val page: LynxLogicalPage, val view: HotUpdaterLynxView)
    private class LivePage(val mount: Mount, val session: LynxLaunchSession) {
        var runtime: ManagedLynxRuntime? = null
        var admitted = session.isPrimary
        var retired = false
    }
    private class Generation(val controller: LynxUpdaterController, val primary: LynxLaunchSession) {
        val pages = linkedMapOf<String, LivePage>()
        // Includes unmounted views until the actual native runtime has detached.
        val runtimes = mutableSetOf<LivePage>()
        val resourceLock = Any()
        var retiring = false
        var replacement: List<LynxLogicalPage>? = null
    }

    private val handler = Handler(Looper.getMainLooper())
    private val launchConfiguration = launchConfiguration.toMap()
    private val mounts = mutableListOf<Mount>()
    private val failedInstallations = mutableSetOf<String>()
    private var generation: Generation? = null
    private var closed = false
    private var replacing = false

    init {
        require(runtimeHost.configuration.pageHostMode == LynxPageHostMode.MOUNTED) {
            "A plain LynxView host requires MOUNTED page mode"
        }
    }

    /** Acquires foreground ownership only when the application's primary container is mounted. */
    fun mountPrimary(context: Context, parameters: Map<String, String> = emptyMap()): HotUpdaterLynxView {
        requireMainThread()
        check(!closed && mounts.isEmpty() && generation == null) { "The host already has a primary or is closed" }
        val mount = newMount(context, runtimeHost.primaryEntry, parameters)
        mounts.add(mount)
        try {
            start(mounts.map { it.page }, reconstructing = false)
        } catch (error: Throwable) {
            failClosed(error)
            throw error
        }
        return mount.view
    }

    /** Declares a secondary immediately; template evaluation waits for earlier admissions. */
    fun mount(context: Context, entry: String, parameters: Map<String, String> = emptyMap()): HotUpdaterLynxView {
        requireMainThread()
        check(!closed && mounts.isNotEmpty()) { "Mount the primary container first" }
        require(mounts.size < 16 && entry in checkNotNull(generation).primary.installation.pageEntries) {
            "The page is unknown or the managed host is full"
        }
        val mount = newMount(context, entry, parameters)
        if (!replacing) {
            val current = checkNotNull(generation)
            current.controller.declareSecondary(current.primary, mount.page)
        }
        mounts.add(mount)
        if (!replacing) drain(checkNotNull(generation))
        return mount.view
    }

    private fun newMount(context: Context, entry: String, parameters: Map<String, String>): Mount {
        require(entry.isNotEmpty() && parameters.keys.none(String::isEmpty)) { "Invalid managed page" }
        val id = UUID.randomUUID().toString()
        return Mount(LynxLogicalPage(entry, parameters.toMap(), id), HotUpdaterLynxView(context) { unmount(id) })
    }

    private fun unmount(id: String) {
        requireMainThread()
        val mount = mounts.singleOrNull { it.page.mountId == id } ?: return
        if (mount === mounts.first()) { close(); return }
        if (!replacing) {
            val current = checkNotNull(generation)
            val page = current.pages[id]
            if (page == null) current.controller.unmountUnlaunchedSecondary(current.primary, id)
            else {
                current.controller.unmountSecondary(page.session)
                retirePage(current, page)
                current.pages.remove(id)
            }
        }
        mounts.remove(mount)
        if (!replacing) drain(checkNotNull(generation))
    }

    private fun start(snapshot: List<LynxLogicalPage>, reconstructing: Boolean) {
        val controller = runtimeHost.createForegroundForMounts(snapshot, reconstructing)
        val primary = try { controller.pinPrimary() } catch (error: Throwable) { controller.close(); throw error }
        val current = Generation(controller, primary)
        generation = current
        check(primary.installation.bundleId !in failedInstallations) {
            "No different complete installation remains after native runtime failure"
        }
        // A replacement first validates its frozen membership. Native mount changes
        // queued during retirement are then applied before any template executes.
        snapshot.drop(1).filter { page -> mounts.none { it.page == page } }.forEach {
            controller.unmountUnlaunchedSecondary(primary, checkNotNull(it.mountId))
        }
        mounts.filter { it.page !in snapshot }.forEach { controller.declareSecondary(primary, it.page) }
        replacing = false
        attach(current, mounts.first(), primary)
        drain(current)
    }

    private fun drain(current: Generation) {
        if (closed || replacing || current !== generation || current.retiring) return
        if (current.pages.values.any { !it.admitted && !it.retired }) return
        val next = mounts.drop(1).firstOrNull { it.page.mountId !in current.pages } ?: return
        try {
            val position = current.controller.retainedLogicalStack(current.primary).indexOf(next.page)
            val session = current.controller.pinSecondary(next.page.entry, next.page.parameters,
                position, current.primary.generationId, reconstructing = true, mountId = next.page.mountId)
            attach(current, next, session)
        } catch (error: Throwable) { recover(current, error) }
    }

    private fun attach(current: Generation, mount: Mount, session: LynxLaunchSession) {
        val page = LivePage(mount, session)
        current.pages[checkNotNull(mount.page.mountId)] = page
        session.installation.essentialResources(session.pageEntry).forEach(session::requireResourceBeforeReady)
        session.setResourceGate { operation -> synchronized(current.resourceLock) {
            check(!current.retiring) { "The managed generation is retired" }
            operation()
        } }
        session.setFailureHandler { message, _, _ -> recover(current, IllegalStateException(message)) }
        session.setReadinessHandlers({}, {
            if (current === generation && !current.retiring && !page.retired) {
                page.admitted = true
                handler.post { drain(current) }
            }
        })
        if (session.isPrimary) session.setReloadHandler { trigger, completion -> reload(current, trigger, completion) }
        try {
            val runtime = createRuntime(mount.view.context, session, launchConfiguration + session.pageParameters) {
                handler.post { detached(current, page) }
            }
            page.runtime = runtime
            current.runtimes.add(page)
            mount.view.addView(runtime.view, FrameLayout.LayoutParams(-1, -1))
            runtime.load()
        } catch (error: Throwable) { recover(current, error) }
    }

    private fun reload(current: Generation, trigger: String, completion: (Result<JSONObject>) -> Unit) {
        requireMainThread()
        val accepted = runCatching {
            check(!closed && !replacing && current === generation) { "The requesting generation is stale" }
            val snapshot = current.controller.retainedLogicalStack(current.primary)
            val result = current.controller.acceptManagedTransition(current.primary,
                current.primary.generationId, snapshot, trigger)
            current.replacement = snapshot
            replacing = true
            result
        }
        try { completion(accepted) } finally {
            if (accepted.isSuccess) handler.post { retireGeneration(current) }
        }
    }

    private fun recover(current: Generation, error: Throwable) {
        if (closed || replacing || current !== generation || current.retiring) return
        android.util.Log.e("HotUpdaterLynx", "Managed runtime failed", error)
        try {
            // Engine and resource callbacks may already have durably recorded it.
            if (!current.controller.generationFailed) current.primary.recordGenerationFailure(error.message ?: "Lynx host failure")
            failedInstallations.add(current.primary.installation.bundleId)
            current.replacement = mounts.map { it.page }
            replacing = true
            handler.post { retireGeneration(current) }
        } catch (failure: Throwable) { failClosed(failure) }
    }

    private fun retirePage(current: Generation, page: LivePage) {
        if (page.retired) return
        page.retired = true
        page.session.close()
        page.runtime?.let {
            page.mount.view.removeView(it.view)
            it.destroy()
        }
    }

    private fun retireGeneration(current: Generation) {
        if (current !== generation || current.retiring) return
        synchronized(current.resourceLock) { current.retiring = true }
        if (current.pages.values.none { it.session === current.primary }) current.primary.close()
        current.pages.values.forEach { retirePage(current, it) }
        finishRetirement(current)
    }

    private fun detached(current: Generation, page: LivePage) {
        if (!current.runtimes.remove(page)) return
        if (!page.retired) recover(current, IllegalStateException("Managed runtime detached before retirement"))
        finishRetirement(current)
    }

    private fun finishRetirement(current: Generation) {
        if (!current.retiring || current.runtimes.isNotEmpty() || current !== generation) return
        current.controller.close()
        generation = null
        if (!closed) try {
            start(checkNotNull(current.replacement), reconstructing = true)
        } catch (error: Throwable) { failClosed(error) }
    }

    private fun failClosed(error: Throwable) {
        close()
        onError(error)
    }

    /** Removing the primary or closing the owner retires every managed view. */
    override fun close() {
        requireMainThread()
        if (closed) return
        closed = true
        mounts.clear()
        generation?.let(::retireGeneration)
    }

    private fun requireMainThread() {
        check(Looper.myLooper() == Looper.getMainLooper()) { "Mount and unmount Lynx containers on the main thread" }
    }
}

/** Detachment/reparenting preserves membership. Close explicitly when the native owner removes it. */
class HotUpdaterLynxView internal constructor(context: Context, private val unmount: () -> Unit) :
    FrameLayout(context), AutoCloseable {
    override fun close() = unmount()
}

/** JNI boundary; selection, readiness and retirement authority remain in the host/controller. */
internal interface ManagedLynxRuntime {
    val view: View
    fun load()
    fun destroy()
}

private class LynxViewRuntime(
    context: Context,
    private val session: LynxLaunchSession,
    private val launchConfiguration: Map<String, String>,
    detached: () -> Unit,
) : ManagedLynxRuntime {
    override val view = LynxViewBuilder().also {
        it.registerModule("HotUpdaterLynx", HotUpdaterLynxModule::class.java)
        session.configure(it)
    }.build(context).also {
        it.addLynxViewClient(object : LynxViewClient() {
            // Lynx invokes this after native module-factory destruction, unlike onDestroy.
            override fun onLynxViewAndJSRuntimeDestroy() = detached()
        })
    }

    override fun load() {
        session.bind(view, launchConfiguration)
        view.renderTemplateUrl(session.entryUrl, session.pageParameters)
    }

    override fun destroy() = view.destroy()
}
