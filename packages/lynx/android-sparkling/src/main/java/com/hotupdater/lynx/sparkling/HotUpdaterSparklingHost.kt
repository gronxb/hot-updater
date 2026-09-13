package com.hotupdater.lynx.sparkling

import android.content.Context
import android.os.Looper
import android.os.Process
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import com.hotupdater.lynx.HotUpdaterLynxModule
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.LynxLaunchDiagnostics
import com.hotupdater.lynx.LynxLaunchSession
import com.hotupdater.lynx.LynxNativeOperationException
import com.hotupdater.lynx.LynxUpdaterController
import com.lynx.tasm.LynxViewBuilder
import com.tiktok.sparkling.SparklingContext
import com.tiktok.sparkling.hybridkit.base.HybridKitType
import com.tiktok.sparkling.hybridkit.lynx.SimpleLynxKitView
import com.tiktok.sparkling.hybridkit.lynx.SparklingLynxModuleWrapper
import com.tiktok.sparkling.hybridkit.scheme.HybridSchemeParam
import java.util.UUID

data class HotUpdaterSparklingConfiguration(
    val lynx: LynxHostConfiguration,
    val requiredStartupResourcePaths: Set<String> = emptySet(),
)

fun interface HotUpdaterSparklingEventListener {
    fun onEvent(name: String, details: Map<String, Any?>)
}

object HotUpdaterSparklingModules {
    @JvmStatic
    fun modules() = mapOf(
        "HotUpdaterLynx" to SparklingLynxModuleWrapper(
            HotUpdaterLynxModule::class.java,
        ),
    )
}

/** Owns every Sparkling/Lynx view in one replaceable native generation. */
class HotUpdaterSparklingHost(
    context: Context,
    internal val configuration: HotUpdaterSparklingConfiguration,
    private val events: HotUpdaterSparklingEventListener? = null,
) : AutoCloseable {
    private val applicationContext = context.applicationContext
    private val containers = linkedSetOf<HotUpdaterSparklingView>()
    private var controller = newController()
    private var generationEvents = SparklingGenerationEvents(events)
    private var closed = false
    private var replacing = false

    fun createView(context: Context, primary: Boolean = containers.isEmpty()): HotUpdaterSparklingView =
        createViews(context, count = 1, firstPrimary = primary).single()

    /** Atomically attaches a primary and its secondaries before publishing membership. */
    fun createViews(
        context: Context,
        count: Int,
        firstPrimary: Boolean = containers.isEmpty(),
    ): List<HotUpdaterSparklingView> {
        requireMainThread()
        check(!closed) { "The managed Lynx host is closed" }
        require(count > 0) { "At least one managed view is required" }
        check(firstPrimary == containers.isEmpty()) {
            "Create exactly one primary before managed secondary views"
        }
        val created = (0 until count).map { index ->
            HotUpdaterSparklingView(context, this, firstPrimary && index == 0)
        }
        containers.addAll(created)
        try {
            created.forEach { it.attach(controller, generationEvents) }
            if (firstPrimary) emitGenerationStarted("initial")
            return created
        } catch (error: Exception) {
            if (!recordGenerationFailure(created, error.message)) {
                failClosed(
                    created,
                    "failureClassificationFailed",
                    error.message,
                )
                throw error
            }
            val replacement = replaceGeneration(
                "initialAttachFailed",
                retry = true,
            )
            if (created.all { it.session != null }) return created
            throw replacement.exceptionOrNull() ?: error
        }
    }

    /** Nonproduction integration evidence retaining only stale session authorities. */
    fun captureDiagnosticAuthorities() = HotUpdaterSparklingStaleProbe(
        containers.mapNotNull { view ->
            val session = view.session ?: return@mapNotNull null
            val identity = view.diagnostics ?: return@mapNotNull null
            Triple(controller, session, identity)
        },
        events,
        generationEvents.id,
    )

    internal fun remove(container: HotUpdaterSparklingView) {
        requireMainThread()
        if (container !in containers) return
        if (container.primary) {
            vacateGeneration("primaryRemoved")
        } else {
            containers.remove(container)
            container.retire()
        }
    }

    internal fun reload(
        generation: SparklingGenerationEvents,
        completion: (Result<Unit>) -> Unit,
    ) {
        requireMainThread()
        completion(SparklingReloadContract.run(
            closed = closed,
            replacing = replacing,
            current = generation === generationEvents,
        ) { replaceGeneration("reload", retry = true) })
    }

    internal fun recover(
        message: String,
        identity: LynxLaunchDiagnostics,
        generation: SparklingGenerationEvents,
    ) {
        if (generation !== generationEvents || replacing || closed) return
        generation.emit(
            "generationFailed",
            details(identity, generation) + ("message" to message),
        )
        if (!recordGenerationFailure(
            containers.toList(),
            message,
        )) {
            failClosed(
                containers.toList(),
                "failureClassificationFailed",
                message,
            )
            return
        }
        replaceGeneration("recovery", retry = true)
    }

    private fun replaceGeneration(
        reason: String,
        retry: Boolean,
    ): Result<Unit> {
        requireMainThread()
        if (closed) return Result.failure(reloadError(
            "HOST_CLOSED",
            "The managed Lynx host is closed",
        ))
        if (replacing) return Result.failure(reloadError(
            "RELOAD_BUSY",
            "A managed Lynx generation replacement is already running",
        ))
        replacing = true
        return try {
            val current = containers.toList()
            val retired = retirementDetails(current, reason)
            generationEvents.beginRetirement(retired)
            current.forEach(HotUpdaterSparklingView::retire)
            controller.close()
            generationEvents.finishRetirement(retired)
            startGeneration()
            try {
                current.sortedByDescending { it.primary }.forEach {
                    it.attach(controller, generationEvents)
                }
            } catch (error: Exception) {
                val classified = recordGenerationFailure(
                    current,
                    error.message,
                )
                val retryRetired = retirementDetails(
                    current,
                    "reconstructionRetry",
                )
                generationEvents.beginRetirement(retryRetired)
                current.forEach(HotUpdaterSparklingView::retire)
                controller.close()
                generationEvents.finishRetirement(retryRetired)
                if (!classified) {
                    containers.clear()
                    closed = true
                    emitReconstructionFailed(
                        retryRetired,
                        "failureClassificationFailed",
                        error.message,
                    )
                    return Result.failure(reloadError(
                        "RECONSTRUCTION_FAILED",
                        error.message ?: "Could not classify the failed Lynx generation",
                        error,
                    ))
                }
                if (!retry) throw error
                startGeneration()
                current.sortedByDescending { it.primary }.forEach {
                    it.attach(controller, generationEvents)
                }
            }
            emitGenerationStarted(reason)
            Result.success(Unit)
        } catch (error: Exception) {
            val current = containers.toList()
            recordGenerationFailure(current, error.message)
            val retired = retirementDetails(current, "reconstructionFailed")
            generationEvents.beginRetirement(retired)
            current.forEach(HotUpdaterSparklingView::retire)
            controller.close()
            generationEvents.finishRetirement(retired)
            containers.clear()
            closed = true
            Log.e(TAG, "Could not reconstruct managed Lynx generation", error)
            emitReconstructionFailed(retired, reason, error.message)
            Result.failure(reloadError(
                "RECONSTRUCTION_FAILED",
                error.message ?: "Could not reconstruct managed Lynx generation",
                error,
            ))
        } finally {
            replacing = false
        }
    }

    private fun reloadError(
        code: String,
        message: String,
        cause: Throwable? = null,
    ) = LynxNativeOperationException(code, message, cause)

    override fun close() {
        requireMainThread()
        if (closed) return
        closed = true
        val current = containers.toList()
        val retired = retirementDetails(current, "close")
        generationEvents.beginRetirement(retired)
        current.forEach(HotUpdaterSparklingView::retire)
        containers.clear()
        controller.close()
        generationEvents.finishRetirement(retired)
    }

    private fun newController() = LynxUpdaterController(
        applicationContext,
        configuration.lynx,
    )

    private fun startGeneration() {
        controller = newController()
        generationEvents = SparklingGenerationEvents(events)
    }

    private fun vacateGeneration(reason: String) {
        if (closed || replacing) return
        replacing = true
        try {
            val current = containers.toList()
            val retired = retirementDetails(current, reason)
            generationEvents.beginRetirement(retired)
            current.forEach(HotUpdaterSparklingView::retire)
            containers.clear()
            controller.close()
            generationEvents.finishRetirement(retired)
            try {
                startGeneration()
            } catch (error: Exception) {
                closed = true
                emitReconstructionFailed(retired, reason, error.message)
            }
        } finally {
            replacing = false
        }
    }

    private fun emitGenerationStarted(reason: String) {
        val current = containers.toList()
        val primary = current.first { it.primary }.diagnostics ?: return
        generationEvents.emit(
            "generationStarted",
            details(primary, generationEvents) + mapOf(
                "contextIds" to current.mapNotNull { it.diagnostics?.contextId },
                "primaryContextId" to primary.contextId,
                "reason" to reason,
            ),
        )
    }

    private fun recordGenerationFailure(
        current: List<HotUpdaterSparklingView>,
        message: String?,
    ): Boolean {
        val primary = current.firstOrNull { it.primary }?.session
            ?: return false
        return runCatching {
            primary.recordGenerationFailure(
                message ?: "Managed view attach failed",
            )
        }.getOrElse { persistenceError ->
            Log.e(TAG, "Could not persist managed generation failure", persistenceError)
            false
        }
    }

    private fun failClosed(
        current: List<HotUpdaterSparklingView>,
        reason: String,
        message: String?,
    ) {
        val retired = retirementDetails(current, reason)
        generationEvents.beginRetirement(retired)
        current.forEach(HotUpdaterSparklingView::retire)
        controller.close()
        generationEvents.finishRetirement(retired)
        containers.clear()
        closed = true
        emitReconstructionFailed(retired, reason, message)
    }

    private fun emitReconstructionFailed(
        retired: Map<String, Any?>,
        reason: String,
        message: String?,
    ) {
        events?.onEvent("generationReconstructionFailed", retired + mapOf(
            "reason" to reason,
            "message" to (message ?: "Managed generation reconstruction failed"),
        ))
    }

    private fun retirementDetails(
        current: List<HotUpdaterSparklingView>,
        reason: String,
    ): Map<String, Any?> {
        val primary = current.firstOrNull { it.primary }?.diagnostics
        return (primary?.let { details(it, generationEvents) } ?: mapOf(
            "processId" to Process.myPid(),
            "generationId" to generationEvents.id,
        )) + mapOf(
            "contextIds" to current.mapNotNull { it.diagnostics?.contextId },
            "reason" to reason,
        )
    }

    internal fun details(
        identity: LynxLaunchDiagnostics,
        generation: SparklingGenerationEvents,
    ) = mapOf(
        "processId" to Process.myPid(),
        "generationId" to generation.id,
        "contextId" to identity.contextId,
        "attemptId" to identity.startupAttemptId,
        "bundleId" to identity.bundleId,
        "releaseId" to identity.releaseId,
    )

    private fun requireMainThread() {
        check(Looper.myLooper() == Looper.getMainLooper()) {
            "Managed Lynx generations must be changed on the main thread"
        }
    }

    companion object {
        private const val TAG = "HotUpdaterSparkling"
    }
}

class HotUpdaterSparklingStaleProbe internal constructor(
    private val authorities: List<Triple<LynxUpdaterController, LynxLaunchSession, LynxLaunchDiagnostics>>,
    private val events: HotUpdaterSparklingEventListener?,
    private val generationId: String,
) {
    fun verifyStaleAuthorities() {
        authorities.forEach { (controller, session, identity) ->
            val rejected = runCatching { controller.diagnostics(session) }.isFailure
            check(rejected) { "A retired Lynx context retained live authority" }
            events?.onEvent("staleContextRejected", mapOf(
                "processId" to Process.myPid(),
                "generationId" to generationId,
                "contextId" to identity.contextId,
                "attemptId" to identity.startupAttemptId,
                "bundleId" to identity.bundleId,
                "releaseId" to identity.releaseId,
                "code" to "STALE_CONTEXT",
            ))
        }
    }
}

class HotUpdaterSparklingView internal constructor(
    context: Context,
    private val host: HotUpdaterSparklingHost,
    internal val primary: Boolean,
) : FrameLayout(context), AutoCloseable {
    internal var session: LynxLaunchSession? = null
        private set
    internal var diagnostics: LynxLaunchDiagnostics? = null
        private set
    private var kit: SimpleLynxKitView? = null
    private var generation: SparklingGenerationEvents? = null

    internal fun attach(
        controller: LynxUpdaterController,
        generation: SparklingGenerationEvents,
    ) {
        check(session == null && kit == null) { "Managed Lynx view is already attached" }
        val launch = if (primary) controller.pinPrimary() else controller.pinSecondary()
        session = launch
        this.generation = generation
        val identity = controller.diagnostics(launch)
        diagnostics = identity
        launch.setFailureHandler { message ->
            host.recover(message, identity, generation)
        }
        if (primary) {
            launch.setReloadHandler { completion ->
                host.reload(generation, completion)
            }
        }
        launch.setReadinessHandlers(
            firstContent = {
                generation.emit(
                    "firstContent",
                    host.details(identity, generation),
                )
            },
            confirmed = { confirmation ->
                generation.emit(
                    "jsReady",
                    host.details(identity, generation) +
                        ("confirmation" to confirmation),
                )
            },
        )
        launch.setResourceGate { operation ->
            check(generation.resourceOperation(operation)) {
                "Managed resource belongs to a retired generation"
            }
        }
        launch.setResourceObserver { event, path, sha256 ->
            val details = host.details(identity, generation) + mapOf(
                "path" to path,
                "sha256" to sha256,
            )
            check(generation.resourceLoaded(event, details)) {
                "Managed resource belongs to a retired generation"
            }
        }
        require(
            launch.installation.managedPaths.containsAll(
                host.configuration.requiredStartupResourcePaths,
            ),
        ) { "A required startup resource is not in the verified release" }
        host.configuration.requiredStartupResourcePaths.forEach(
            launch::requireResourceBeforeReady,
        )

        val entry = launch.entryUrl
        val sparkling = SparklingContext().apply {
            hybridSchemeParam = HybridSchemeParam(
                engineType = HybridKitType.LYNX,
                bundle = entry,
            )
            scheme = "hybrid://lynxview_page?bundle=$entry"
            containerId = UUID.randomUUID().toString()
        }
        val builder = LynxViewBuilder().also(launch::configure)
        val nextKit = SimpleLynxKitView(context, sparkling, builder, null, null)
        launch.bind(nextKit)
        kit = nextKit
        addView(
            nextKit,
            LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        generation.emit(
            "generationWillEvaluate",
            host.details(identity, generation) + ("primary" to primary),
        )
        nextKit.load()
    }

    internal fun retire() {
        val oldSession = session
        val oldKit = kit
        session = null
        diagnostics = null
        generation = null
        kit = null
        oldKit?.destroy(true)
        oldKit?.let(::removeView)
        oldSession?.close()
    }

    /** Nonproduction integration hook exercising the packaged fatal path. */
    fun triggerFatalFailureForDiagnostics(
        message: String = "diagnostic fatal failure",
    ) {
        val identity = checkNotNull(diagnostics) {
            "The managed Lynx context is detached"
        }
        checkNotNull(session) { "The managed Lynx context is detached" }
        val activeGeneration = checkNotNull(generation) {
            "The managed Lynx context is detached"
        }
        activeGeneration.emit(
            "runtimeFailed",
            host.details(identity, activeGeneration) + ("message" to message),
        )
        host.recover(message, identity, activeGeneration)
    }

    override fun close() = host.remove(this)
}
