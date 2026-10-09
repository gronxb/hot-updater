package com.hotupdater.lynx

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.lynx.jsbridge.CommonModuleCreator
import com.lynx.jsbridge.RuntimeLifecycleListener
import com.lynx.tasm.LynxBackgroundRuntime
import com.lynx.tasm.LynxBackgroundRuntimeClient
import com.lynx.tasm.LynxBackgroundRuntimeOptions
import com.lynx.tasm.LynxBooleanOption
import com.lynx.tasm.LynxEnv
import com.lynx.tasm.LynxError
import com.lynx.tasm.LynxGroup
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/** JS output accompanied by the receipt captured by native code before evaluation. */
class LynxBackgroundResult internal constructor(snapshot: LynxBackgroundSnapshot, val value: String) {
    val taskId: String = snapshot.taskId
    val bundleId: String = snapshot.selection.bundleId
    val releaseId: String? = snapshot.selection.releaseId
    val manifestHash: String = snapshot.manifestHash
    val entry: String = snapshot.entry
    private val receipt = snapshot.selection.toJson().toString()
    fun selection(): JSONObject = JSONObject(receipt)
}

/** A viewless runtime with no foreground session, navigation, or readiness bridge. */
internal class LynxBackgroundExecutor(
    context: Context,
    private val host: LynxRuntimeHost,
    callback: (Result<LynxBackgroundResult>) -> Unit,
) : AutoCloseable {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var task: LynxBackgroundTask? = null
    private var runtime: LynxBackgroundRuntime? = null
    private var group: LynxGroup? = null
    private val lifecycle = LynxBackgroundLifecycle(
        destroy = { runtime?.destroy() },
        persistFatal = { message -> task?.reportFatal(message) },
        release = { task?.close() },
        reply = { result ->
            callback(result.map { LynxBackgroundResult(checkNotNull(task).snapshot, it) })
        },
    )
    private val timeout = Runnable { lifecycle.stop(TimeoutException("Lynx background task exceeded 25 seconds")) }
    private val client = object : LynxBackgroundRuntimeClient() {
        override fun onReceivedError(error: LynxError) {
            // Lynx already enqueues errors on main. Reposting could move a fatal past detach.
            val failure = IllegalStateException("Lynx background error ${error.errorCode}: ${error.msg}")
            lifecycle.nativeError(failure, error.isFatal)
        }
    }

    init {
        main.post {
            main.postDelayed(timeout, 25_000)
            CoroutineScope(Dispatchers.IO).launch {
                // The reservation and immutable script copy are acquired away from the UI thread.
                val acquired = runCatching { host.beginBackground() }
                main.post {
                    acquired.fold(
                        { selected ->
                            task = selected
                            if (lifecycle.stopping) detached() else start()
                        },
                        { error -> lifecycle.stop(error); detached() },
                    )
                }
            }
        }
    }

    private fun start() {
        active.add(this)
        try {
            check(LynxEnv.inst().isNativeLibraryLoaded) { "Initialize Lynx before running a background task" }
            val snapshot = checkNotNull(task).snapshot
            val taskGroup = LynxGroup.LynxGroupBuilder()
                .setGroupName("hot-updater-background")
                .setID(snapshot.taskId)
                .setEnableJSGroupThread(true)
                .setJSGroupThreadName(snapshot.taskId)
                .setEnableWhiteBoard(false)
                .setEnableV8(false)
                .build().also { group = it }
            val options = LynxBackgroundRuntimeOptions().apply {
                lynxGroup = taskGroup
                setEnableUserBytecode(false)
                setPendingCoreJsLoad(false)
                setEnableGenericResourceFetcher(LynxBooleanOption.TRUE)
                genericResourceFetcher = LynxBackgroundResources.generic
                templateResourceFetcher = LynxBackgroundResources.template
                registerModule(HotUpdaterBackgroundModule.NAME, HotUpdaterBackgroundModule::class.java,
                    LynxBackgroundCompletionSink { value -> main.post { lifecycle.complete(value) } })
                registerModuleAuthValidator { module, method, _ ->
                    module == HotUpdaterBackgroundModule.NAME && method == "complete"
                }
            }
            val engine = LynxBackgroundRuntime(app, options, false).also { runtime = it }
            check(engine.state == LynxBackgroundRuntime.STATE_START && engine.nativePtr != 0L) {
                "Lynx did not create a background runtime"
            }
            engine.addRuntimeLifecycleListener(object : RuntimeLifecycleListener {
                override fun onRuntimeAttach(runtimeId: Long) = Unit
                override fun onRuntimeDetach() { main.post { detached() } }
            })
            engine.addLynxBackgroundRuntimeClient(client)
            engine.moduleFactory.let { factory ->
                factory.bind(LynxBackgroundModuleCreator(CommonModuleCreator(factory.currentContextFinder())))
            }
            // Leading slash is required by Lynx 3.9's standalone script lookup.
            engine.evaluateJavaScript("/hot-updater-background/${snapshot.taskId}/${snapshot.entry}", snapshot.source)
        } catch (error: Throwable) {
            lifecycle.stop(error)
            // STATE_INVALID creates no native runtime, so no detach callback can arrive.
            if (runtime == null || runtime?.nativePtr == 0L) detached()
        }
    }

    private fun detached() {
        main.removeCallbacks(timeout)
        runtime?.removeLynxBackgroundRuntimeClient(client)
        runtime = null
        group?.destroy()
        group = null
        active.remove(this)
        lifecycle.onDetached()
    }

    override fun close() {
        main.post { lifecycle.stop(CancellationException("Lynx background task cancelled")) }
    }

    private companion object {
        // Keep engines alive until native detach; destroy() only queues their teardown.
        val active = mutableSetOf<LynxBackgroundExecutor>()
    }
}
