package com.hotupdater.lynx.sparkling

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import android.view.ViewGroup
import android.widget.FrameLayout
import com.hotupdater.lynx.HotUpdaterLynxModule
import com.hotupdater.lynx.LynxHostConfiguration
import com.hotupdater.lynx.LynxLaunchDiagnostics
import com.hotupdater.lynx.LynxLaunchSession
import com.hotupdater.lynx.LynxLogicalPage
import com.hotupdater.lynx.LynxNativeOperationException
import com.hotupdater.lynx.LynxPageCancelReason
import com.hotupdater.lynx.LynxUpdaterController
import com.lynx.tasm.LynxViewBuilder
import com.tiktok.sparkling.SparklingContext
import com.tiktok.sparkling.hybridkit.base.HybridKitType
import com.tiktok.sparkling.hybridkit.lynx.SimpleLynxKitView
import com.tiktok.sparkling.hybridkit.lynx.SparklingLynxModuleWrapper
import com.tiktok.sparkling.hybridkit.scheme.HybridSchemeParam
import com.tiktok.sparkling.method.registry.api.SparklingBridge
import com.tiktok.sparkling.method.registry.core.IBridgeContext
import java.lang.ref.WeakReference
import java.util.UUID
import org.json.JSONObject

data class HotUpdaterSparklingConfiguration(
    val lynx: LynxHostConfiguration,
    val launchConfiguration: Map<String, String> = emptyMap(),
    /** Enables nonproduction launch overrides supplied through an Activity intent. */
    val allowDiagnosticIntentLaunchConfiguration: Boolean = false,
    @Deprecated(
        "Page resources are declared by pageEssentialResources metadata",
    )
    val requiredStartupResourcePaths: Set<String> = emptySet(),
) {
    init {
        require(requiredStartupResourcePaths.isEmpty()) {
            "Use manifest-covered pageEssentialResources for readiness"
        }
    }
}

fun interface HotUpdaterSparklingEventListener {
    fun onEvent(name: String, details: Map<String, Any?>)
}

internal interface ManagedSparklingRouteAuthority {
    fun open(
        sourceBridgeContext: IBridgeContext?,
        scheme: String,
        animated: Boolean,
    ): Boolean

    fun close(
        sourceBridgeContext: IBridgeContext?,
        requestedContainerId: String?,
        animated: Boolean,
    ): Boolean
}

/** Registration called by the application while configuring Sparkling. */
object HotUpdaterSparklingModules {
    @JvmStatic
    fun modules() = mapOf(
        "HotUpdaterLynx" to SparklingLynxModuleWrapper(
            HotUpdaterLynxModule::class.java,
        ),
    )

    @JvmStatic
    fun registerNavigation() = ManagedSparklingBridge.register()
}

/**
 * Owns one ordered full-page Activity stack and one immutable release per
 * generation. An application Activity mounts the primary; every pushed route
 * is hosted by [HotUpdaterSparklingPageActivity].
 */
class HotUpdaterSparklingHost(
    context: Context,
    internal val configuration: HotUpdaterSparklingConfiguration,
    private val events: HotUpdaterSparklingEventListener? = null,
) : AutoCloseable, ManagedSparklingPageAuthority, ManagedSparklingRouteAuthority {
    private val applicationContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val hostId = UUID.randomUUID().toString()
    internal val eventSink = SparklingRuntimeEventSink(applicationContext, events)
    internal val pages = mutableListOf<ManagedPage>()
    internal var controller = newController()
    internal var generationEvents = SparklingGenerationEvents(eventSink)
    internal var pageCreatedObserver: ((ManagedPage) -> Unit)? = null
    internal var pageProgressObserver: ((ManagedPage) -> Unit)? = null
    private var closed = false
    private var transitioning = false
    private var pendingReconstruction = emptyList<LynxLogicalPage>()
    private var runtimeGenerationEpoch = 1
    private var pendingGenerationStartReason = "initial"

    init {
        ManagedSparklingBridge.register()
        ManagedSparklingHostRegistry.add(hostId, this)
    }

    fun createView(
        context: Context,
        primary: Boolean = pages.isEmpty(),
    ): HotUpdaterSparklingView {
        requireMainThread()
        check(primary && pages.isEmpty()) {
            "Only the host-designated primary is mounted by the application"
        }
        check(!closed) { "The managed Lynx host is closed" }
        val activity = checkNotNull(context.activity()) {
            "A managed full-page Lynx container requires an Activity"
        }
        val session = controller.pinPrimary(
            generationId = generationEvents.id,
            parameters = emptyMap(),
        )
        val logicalStack = controller.retainedLogicalStack(session)
        val page = ManagedPage(
            id = UUID.randomUUID().toString(),
            containerId = UUID.randomUUID().toString(),
            logical = logicalStack.first(),
            primary = true,
            session = session,
            activity = WeakReference(activity),
        )
        pages += page
        pendingGenerationStartReason = "initial"
        val view = attach(page, activity)
        pendingReconstruction = logicalStack.drop(1)
        openNextReconstructedPage()
        return view
    }

    override fun attachPage(
        pageId: String,
        activity: HotUpdaterSparklingPageActivity,
    ): HotUpdaterSparklingView? {
        requireMainThread()
        val page = pages.singleOrNull { it.id == pageId } ?: return null
        if (page.activity.get() != null && page.activity.get() !== activity) {
            return null
        }
        return attachRecreatedPage(page, activity)
    }

    /** Reuses the host while rebuilding the root Activity after OS recreation. */
    fun reattachPrimary(activity: Activity): HotUpdaterSparklingView {
        requireMainThread()
        check(!closed && !transitioning)
        val primary = pages.firstOrNull()?.takeIf { it.primary && it.recreating }
            ?: error("The managed primary page is not awaiting reattachment")
        return attachRecreatedPage(primary, activity)
    }

    /** Retires Activity-bound objects while retaining the durable generation. */
    fun primaryActivityDetachedForRecreation(activity: Activity) {
        requireMainThread()
        val primary = pages.firstOrNull()?.takeIf {
            it.primary && it.activity.get() === activity
        } ?: return
        if (closed || transitioning) return
        detachForRecreation(primary)
    }

    override fun requestBack(activity: Activity): Boolean {
        requireMainThread()
        if (closed || transitioning) return true
        val source = pages.singleOrNull { it.activity.get() === activity }
            ?: return false
        return closePage(
            source,
            animated = true,
            reason = LynxPageCancelReason.NATIVE_BACK,
        )
    }

    override fun activityDetached(activity: Activity) {
        requireMainThread()
        val page = pages.singleOrNull { it.activity.get() === activity }
            ?: return
        if (page.closing || transitioning || closed) return
        if (!activity.isChangingConfigurations) {
            val message = "Managed page Activity was destroyed before close"
            if (page.session.recordFatalFailure(message)) {
                recover(message, page, generationEvents)
            }
            return
        }
        detachForRecreation(page)
    }

    override fun pageAttachFailed(
        pageId: String,
        activity: HotUpdaterSparklingPageActivity,
        error: Throwable,
    ) {
        requireMainThread()
        val page = pages.singleOrNull { it.id == pageId } ?: return
        if (
            page.activity.get() !== activity || page.attachFailureReported ||
            closed || transitioning
        ) return
        page.attachFailureReported = true
        val message = error.message ?: "Managed page attachment failed"
        val accepted = if (!page.admitted) {
            page.session.recordFatalFailure(message)
        } else {
            pages.firstOrNull()?.session?.recordGenerationFailure(message) == true
        }
        if (accepted) recover(message, page, generationEvents)
    }

    private fun detachForRecreation(page: ManagedPage) {
        page.failureGate.beginRebind()
        (page.view?.parent as? ViewGroup)?.removeView(page.view)
        page.session.prepareForRebind()?.let { context ->
            ManagedSparklingHostRegistry.unbindContext(context, this)
        }
        page.sourceBridgeContext?.let { context ->
            ManagedSparklingHostRegistry.unbindBridgeContext(context, this)
        }
        page.view?.retire()
        page.sparklingBridge?.release()
        page.view = null
        page.sourceContext = null
        page.sourceBridgeContext = null
        page.sparklingBridge = null
        page.firstContentObserved = false
        page.observedEssentialResources.clear()
        page.recreating = true
        generationEvents.emit(
            "pageContainerDetached",
            details(page) + mapOf(
                "orderedPageEntries" to pages.map { it.logical.entry },
                "topPageEntry" to pages.last().logical.entry,
            ),
        )
        page.activity = WeakReference(null)
    }

    private fun attachRecreatedPage(
        page: ManagedPage,
        activity: Activity,
    ): HotUpdaterSparklingView {
        val reattaching = page.recreating
        page.activity = WeakReference(activity)
        val view = try {
            page.view ?: attach(page, activity)
        } finally {
            page.recreating = false
            page.failureGate.completeRebind()
        }
        if (reattaching && !transitioning) {
            generationEvents.emit(
                "pageContainerReattached",
                details(page) + mapOf(
                    "orderedPageEntries" to pages.map { it.logical.entry },
                    "topPageEntry" to pages.last().logical.entry,
                ),
            )
        }
        return view
    }

    override fun open(
        sourceBridgeContext: IBridgeContext?,
        scheme: String,
        animated: Boolean,
    ): Boolean {
        requireMainThread()
        if (closed || transitioning) return false
        val sourceContainerId = sourceBridgeContext?.containerID
        val source = pages.singleOrNull {
            it.containerId == sourceContainerId &&
                runCatching { controller.diagnostics(it.session) }.isSuccess &&
                it.session.generationId == generationEvents.id
        } ?: return false
        val activity = source.activity.get() ?: return false
        if (!authorizedSourceBridgeContext(
                sourceBridgeContext,
                source.sourceBridgeContext,
                activity,
                sourceBridgeContext?.let(
                    ManagedSparklingHostRegistry::hostForBridgeContext
                ) ===
                    this,
                source.containerId,
            )
        ) {
            return false
        }
        val route = ManagedSparklingRoute.parse(
            scheme,
            source.session.installation.pageEntries.toSet(),
        )
        return openPage(
            activity,
            LynxLogicalPage(route.pageEntry, route.parameters),
            animated,
            reconstructing = false,
            sourceContextId = checkNotNull(source.diagnostics).contextId,
        )
    }

    override fun close(
        sourceBridgeContext: IBridgeContext?,
        requestedContainerId: String?,
        animated: Boolean,
    ): Boolean {
        requireMainThread()
        if (closed || transitioning) return false
        val sourceContainerId = sourceBridgeContext?.containerID
        val source = pages.singleOrNull {
            it.containerId == sourceContainerId &&
                runCatching { controller.diagnostics(it.session) }.isSuccess &&
                it.session.generationId == generationEvents.id
        } ?: return false
        val activity = source.activity.get() ?: return false
        if (!authorizedSourceBridgeContext(
                sourceBridgeContext,
                source.sourceBridgeContext,
                activity,
                sourceBridgeContext?.let(
                    ManagedSparklingHostRegistry::hostForBridgeContext
                ) ===
                    this,
                source.containerId,
            )
        ) {
            return false
        }
        if (requestedContainerId != null && requestedContainerId != source.containerId) {
            return false
        }
        return closePage(
            source,
            animated,
            reason = LynxPageCancelReason.SPARKLING_CLOSE,
        )
    }

    internal fun openPage(
        sourceActivity: Activity,
        logical: LynxLogicalPage,
        animated: Boolean,
        reconstructing: Boolean,
        sourceContextId: String,
    ): Boolean {
        check(logical.entry in pages.first().session.installation.pageEntries) {
            "Unknown managed page entry"
        }
        val position = if (reconstructing) {
            val retained = controller.retainedLogicalStack(pages.first().session)
            pages.size.takeIf {
                it in 1 until retained.size && retained[it] == logical
            } ?: return false
        } else {
            pages.size
        }
        val session = controller.pinSecondary(
            pageEntry = logical.entry,
            parameters = logical.parameters,
            stackPosition = position,
            generationId = generationEvents.id,
            reconstructing = reconstructing,
            nativePageClass = HotUpdaterSparklingPageActivity::class.java.name,
            sourceContextId = sourceContextId,
        )
        val page = ManagedPage(
            id = UUID.randomUUID().toString(),
            containerId = UUID.randomUUID().toString(),
            logical = logical,
            primary = false,
            session = session,
            activity = WeakReference<Activity>(null),
            diagnostics = controller.diagnostics(session),
        )
        pages += page
        var activityStarted = false
        return try {
            pageCreatedObserver?.invoke(page)
            val intent = Intent(
                sourceActivity,
                HotUpdaterSparklingPageActivity::class.java,
            )
                .putExtra(HotUpdaterSparklingPageActivity.EXTRA_HOST_ID, hostId)
                .putExtra(HotUpdaterSparklingPageActivity.EXTRA_PAGE_ID, page.id)
                .putExtra(HotUpdaterSparklingPageActivity.EXTRA_ANIMATED, animated)
            sourceActivity.startActivity(intent)
            activityStarted = true
            if (!animated) sourceActivity.overridePendingTransition(0, 0)
            check(generationEvents.emit(
                "routeOpened",
                details(page) + mapOf(
                    "sourceContextId" to sourceContextId,
                    "orderedPageEntries" to pages.map { it.logical.entry },
                    "orderedPageParameters" to pages.map { it.logical.parameters },
                    "topPageEntry" to logical.entry,
                    "animated" to animated,
                    "outcome" to "opened",
                    "cause" to if (reconstructing) {
                        "reconstruction"
                    } else {
                        "router.open"
                    },
                ),
            )) { "Managed generation retired while opening a page" }
            true
        } catch (error: Throwable) {
            if (!activityStarted && runCatching {
                    controller.rollbackSecondary(session)
                }.getOrDefault(false)
            ) {
                pages.remove(page)
                session.close()
            } else if (runCatching {
                    session.recordFatalFailure(
                        error.message ?: "Managed page launch failed",
                    )
                }.getOrDefault(false)
            ) {
                recover(
                    error.message ?: "Managed page launch failed",
                    page,
                    generationEvents,
                )
            }
            throw error
        }
    }

    internal fun closePage(
        page: ManagedPage,
        animated: Boolean,
        finishActivity: Boolean = true,
        reason: LynxPageCancelReason,
    ): Boolean {
        if (page.primary || pages.lastOrNull() !== page || page.closing) {
            return false
        }
        if (!controller.cancelSecondaryForHost(page.session, reason)) return false
        page.closing = true
        val pendingAttempt = !page.admitted
        if (pendingAttempt) pendingReconstruction = emptyList()
        pages.removeAt(pages.lastIndex)
        val activity = page.activity.get()
        if (pendingAttempt) {
            emitPageAttemptTerminal(
                page,
                terminal = "authorized-cancel",
                reason = reason.wireValue,
                topContextId = pages.lastOrNull()?.diagnostics?.contextId,
            )
        }
        retirePage(page)
        generationEvents.emit(
            "routeClosed",
            details(page) + mapOf(
                "sourceContextId" to checkNotNull(page.diagnostics).contextId,
                "orderedPageEntries" to pages.map { it.logical.entry },
                "orderedPageParameters" to pages.map { it.logical.parameters },
                "topPageEntry" to pages.last().logical.entry,
                "animated" to animated,
                "outcome" to "closed",
                "cause" to routeCloseCause(reason),
            ),
        )
        if (finishActivity) {
            activity?.finish()
            if (!animated) activity?.overridePendingTransition(0, 0)
        }
        controller.flushPrimaryReadinessAfterHostEvent()
        return true
    }

    internal fun reload(
        generation: SparklingGenerationEvents,
        trigger: String,
        completion: (Result<JSONObject>) -> Unit,
    ) {
        requireMainThread()
        val rejection = when {
            closed -> transitionError("HOST_CLOSED", "The managed Lynx host is closed")
            transitioning -> transitionError(
                "TRANSITION_IN_PROGRESS",
                "A managed Lynx transition is already accepted",
            )
            generation !== generationEvents -> transitionError(
                "STALE_CONTEXT",
                "The requesting Lynx generation is no longer current",
            )
            else -> null
        }
        if (rejection != null) {
            completion(Result.failure(rejection))
            return
        }
        val primary = pages.firstOrNull()?.takeIf { it.primary }
        if (primary == null) {
            completion(Result.failure(transitionError(
                "STALE_CONTEXT",
                "The managed primary page is unavailable",
            )))
            return
        }
        val accepted = runCatching {
            controller.acceptManagedTransition(
                primary.session,
                generationEvents.id,
                pages.map { it.logical },
                trigger,
            )
        }
        val result = accepted.getOrNull()
        if (result == null) {
            completion(Result.failure(checkNotNull(accepted.exceptionOrNull())))
            return
        }
        transitioning = true
        pages.filter { !it.primary && !it.admitted }.forEach { page ->
            emitPageAttemptTerminal(
                page,
                terminal = "authorized-cancel",
                reason = "managedTransition",
                transitionId = result.getString("transitionId"),
                topContextId = pages.lastOrNull { it.primary || it.admitted }
                    ?.diagnostics?.contextId,
            )
        }
        generationEvents.emit(
            "transitionAccepted",
            details(primary) + mapOf(
                "status" to "TRANSITION_ACCEPTED",
                "transitionId" to result.getString("transitionId"),
                "trigger" to trigger,
                "sourceContextId" to checkNotNull(primary.diagnostics).contextId,
                "orderedPageEntries" to pages.map { it.logical.entry },
                "orderedPageParameters" to pages.map { it.logical.parameters },
                "topPageEntry" to pages.last().logical.entry,
            ),
        )
        // Deliver acceptance while the source bridge and context are live. The
        // queued replacement cannot settle the old Promise a second time.
        deliverTransitionAcceptance(
            result,
            completion,
        ) { mainHandler.post { replaceGeneration(trigger) } }
    }

    internal fun recover(
        message: String,
        page: ManagedPage,
        generation: SparklingGenerationEvents,
        failureCode: Int? = null,
        failureResourcePath: String? = null,
    ) {
        if (generation !== generationEvents || transitioning || closed) return
        val failureDetails = details(page).toMutableMap().apply {
            put("message", message)
            failureCode?.let { put("failureCode", it) }
            failureResourcePath?.let { put("failureResourcePath", it) }
        }
        generation.emit("runtimeFailed", failureDetails)
        if (!page.primary && !page.admitted) {
            emitPageAttemptTerminal(
                page,
                terminal = "verified-fatal",
                transitionId = page.transitionAttribution.id,
                topContextId = pages.lastOrNull { it !== page }
                    ?.diagnostics?.contextId,
                failureCode = failureCode,
                failureResourcePath = failureResourcePath,
            )
        }
        generation.emit(
            "generationFailed",
            details(page) + ("message" to message),
        )
        transitioning = true
        mainHandler.post { replaceGeneration("recovery") }
    }

    private fun replaceGeneration(reason: String) {
        requireMainThread()
        if (closed) return
        pageCreatedObserver = null
        pageProgressObserver = null
        val retained = pages.map { it.logical }
        val primaryActivity = pages.firstOrNull()?.activity?.get()
        val secondaryActivities = pages.drop(1).mapNotNull {
            it.activity.get() as? HotUpdaterSparklingPageActivity
        }
        val retired = retirementDetails(reason)
        var terminalFailureDetails = retired
        try {
            generationEvents.beginRetirement(retired)
            pages.drop(1).forEach { it.closing = true }
            pages.forEach(::retirePage)
            pages.clear()
            secondaryActivities.forEach(Activity::finish)
            controller.close()
            generationEvents.finishRetirement(retired)
            val rootActivity = checkNotNull(primaryActivity) {
                "The primary Activity cannot be reconstructed"
            }
            mainHandler.post {
                reconstructGeneration(
                    rootActivity,
                    reason,
                    retained,
                    retired,
                )
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Managed Lynx generation failed closed", error)
            pages.forEach(::retirePage)
            pages.clear()
            runCatching { controller.close() }
            closed = true
            transitioning = false
            ManagedSparklingHostRegistry.remove(hostId, this)
            eventSink.onEvent(
                "generationReconstructionFailed",
                terminalFailureDetails + mapOf(
                    "reason" to reason,
                    "message" to (error.message ?: "Managed generation failed closed"),
                ),
            )
            primaryActivity?.finish()
        }
    }

    private fun reconstructGeneration(
        rootActivity: Activity,
        reason: String,
        retained: List<LynxLogicalPage>,
        retired: Map<String, Any?>,
    ) {
        requireMainThread()
        if (closed) return
        var launchReason = reason
        var terminalFailureDetails = retired
        try {
            repeat(MAX_RECONSTRUCTION_ATTEMPTS) {
                controller = newController()
                runtimeGenerationEpoch += 1
                generationEvents = SparklingGenerationEvents(eventSink)
                var primarySession: LynxLaunchSession? = null
                try {
                    pendingGenerationStartReason = launchReason
                    primarySession = controller.pinPrimary(
                        generationEvents.id,
                        retained.first().parameters,
                    )
                    val rebuiltStack = controller.retainedLogicalStack(
                        primarySession,
                    )
                    check(rebuiltStack == retained) {
                        "The selected release changed the retained logical stack"
                    }
                    val primary = ManagedPage(
                        id = UUID.randomUUID().toString(),
                        containerId = UUID.randomUUID().toString(),
                        logical = rebuiltStack.first(),
                        primary = true,
                        session = primarySession,
                        activity = WeakReference(rootActivity),
                    )
                    pages += primary
                    rootActivity.setContentView(attach(primary, rootActivity))
                    pendingReconstruction = rebuiltStack.drop(1)
                    openNextReconstructedPage()
                    transitioning = false
                    return
                } catch (error: Throwable) {
                    Log.e(
                        TAG,
                        "Could not reconstruct managed Lynx generation",
                        error,
                    )
                    val failedBundle = primarySession?.installation?.bundleId
                    val failedDetails = reconstructionFailureDetails(
                        primarySession,
                        retained,
                        retired["transitionId"] as? String,
                        "reconstructionRecovery",
                    )
                    primarySession?.let { session ->
                        runCatching {
                            session.recordGenerationFailure(
                                error.message
                                    ?: "Managed generation reconstruction failed",
                            )
                        }
                    }
                    if (primarySession != null) {
                        terminalFailureDetails = failedDetails
                    }
                    runCatching {
                        generationEvents.beginRetirement(failedDetails)
                        pages.drop(1).forEach { it.closing = true }
                        pages.forEach(::retirePage)
                        pages.mapNotNull { it.activity.get() }
                            .filterIsInstance<HotUpdaterSparklingPageActivity>()
                            .forEach(Activity::finish)
                        primarySession.takeIf { session ->
                            pages.none { it.session === session }
                        }?.close()
                        pages.clear()
                        controller.close()
                        generationEvents.finishRetirement(failedDetails)
                    }
                    if (
                        primarySession == null ||
                        failedBundle == configuration.lynx.embeddedBundleId
                    ) {
                        throw error
                    }
                    launchReason = "recovery"
                }
            }
            error("Managed generation recovery capacity exhausted")
        } catch (error: Throwable) {
            Log.e(TAG, "Managed Lynx generation failed closed", error)
            pages.forEach(::retirePage)
            pages.clear()
            runCatching { controller.close() }
            closed = true
            transitioning = false
            ManagedSparklingHostRegistry.remove(hostId, this)
            eventSink.onEvent(
                "generationReconstructionFailed",
                terminalFailureDetails + mapOf(
                    "reason" to reason,
                    "message" to (
                        error.message ?: "Managed generation failed closed"
                    ),
                ),
            )
            rootActivity.finish()
        }
    }

    private fun openNextReconstructedPage() {
        if (pendingReconstruction.isEmpty() || closed) return
        if (pages.any { !it.primary && !it.admitted }) return
        val logical = pendingReconstruction.first()
        val source = pages.last().activity.get() ?: pages.first().activity.get()
            ?: error("No live Activity can reconstruct the managed stack")
        try {
            check(openPage(
                source,
                logical,
                animated = false,
                reconstructing = true,
                sourceContextId = checkNotNull(pages.last().diagnostics).contextId,
            )) { "The retained managed page could not be reconstructed" }
            pendingReconstruction = pendingReconstruction.drop(1)
        } catch (error: Throwable) {
            if (transitioning) throw error
            val primary = pages.firstOrNull()?.takeIf { it.primary }
                ?: throw error
            val message = error.message ?: "Managed page reconstruction failed"
            if (primary.session.recordGenerationFailure(message)) {
                recover(message, primary, generationEvents)
            }
        }
    }

    private fun attach(
        page: ManagedPage,
        activity: Activity,
    ): HotUpdaterSparklingView {
        check(page.view == null) { "Managed page is already attached" }
        val generation = generationEvents
        val identity = controller.diagnostics(page.session)
        page.diagnostics = identity
        page.transitionAttribution.id = runCatching {
            controller.pendingManagedTransition(page.session)?.transitionId
        }.getOrNull()
        val launch = page.session
        if (!page.failureHandlerInstalled) {
            launch.setFailureHandler { message, failureCode, resourcePath ->
                page.failureGate.deliver {
                    recover(
                        message,
                        page,
                        generation,
                        failureCode,
                        resourcePath,
                    )
                }
            }
            page.failureHandlerInstalled = true
        }
        if (page.primary) {
            launch.setReloadHandler { trigger, completion ->
                reload(generation, trigger, completion)
            }
        }
        launch.setEngineDiagnosticHandler { diagnostic ->
            generation.emit(
                "engineDiagnostic",
                details(page) + diagnostic,
            )
        }
        launch.setReadinessHandlers(
            firstContent = {
                generation.emit(
                    "firstContent",
                    details(page),
                )
                page.firstContentObserved = true
                pageProgressObserver?.invoke(page)
            },
            confirmed = { confirmation ->
                val accepted = generation.emit(
                    if (page.primary) "jsReady" else "pageAdmitted",
                    details(page) + ("confirmation" to confirmation),
                )
                if (accepted) {
                    page.admitted = true
                    if (!page.primary) {
                        emitPageAttemptTerminal(
                            page,
                            terminal = "admitted",
                            transitionId = page.transitionAttribution.id,
                            topContextId = page.diagnostics?.contextId,
                        )
                    }
                    if (!page.primary) openNextReconstructedPage()
                }
                if (page.primary) {
                    pages.forEach { it.transitionAttribution.complete() }
                }
            },
        )
        launch.setResourceGate { operation ->
            check(generation.resourceOperation(operation)) {
                "Managed resource belongs to a retired generation"
            }
        }
        launch.setResourceObserver { event, path, sha256 ->
            check(generation.resourceLoaded(
                event,
                details(page) + mapOf("path" to path, "sha256" to sha256),
            )) { "Managed resource belongs to a retired generation" }
            if (path in page.expectedEssentialResources) {
                page.observedEssentialResources += path
                pageProgressObserver?.invoke(page)
            }
        }
        page.expectedEssentialResources =
            launch.installation.essentialResources(page.logical.entry).toSet()
        page.expectedEssentialResources.forEach(launch::requireResourceBeforeReady)

        val entry = launch.entryUrl
        val sparkling = SparklingContext().apply {
            hybridSchemeParam = HybridSchemeParam(
                engineType = HybridKitType.LYNX,
                bundle = entry,
            )
            scheme = "hybrid://lynxview_page?bundle=$entry"
            containerId = page.containerId
        }
        val builder = LynxViewBuilder().also(launch::configure)
        val bridge = SparklingBridge()
        var constructedKit: SimpleLynxKitView? = null
        val kit = try {
            bridge.registerLynxModule(builder, page.containerId)
            SimpleLynxKitView(activity, sparkling, builder, null, null).also {
                constructedKit = it
                bridge.init(it, page.containerId, SPARKLING_LYNX_PLATFORM)
                sparkling.bridge = bridge
                launch.bind(
                    it,
                    HotUpdaterSparklingLaunchConfiguration.resolve(
                        configuration.launchConfiguration,
                        configuration.allowDiagnosticIntentLaunchConfiguration,
                        activity,
                        page.logical.parameters,
                        runtimeGenerationEpoch.toString(),
                    ),
                )
            }
        } catch (error: Throwable) {
            runCatching { launch.prepareForRebind() }
            runCatching { constructedKit?.destroy(true) }
            runCatching { bridge.release() }
            throw error
        }
        val bridgeContext = bridge.getBridgeSDKContext()
        ManagedSparklingHostRegistry.bindContext(kit.lynxContext, this)
        ManagedSparklingHostRegistry.bindBridgeContext(bridgeContext, this)
        page.sourceContext = kit.lynxContext
        page.sourceBridgeContext = bridgeContext
        page.sparklingBridge = bridge
        val view = HotUpdaterSparklingView(activity, kit)
        page.view = view
        generation.emit(
            "generationWillEvaluate",
            details(page) + ("primary" to page.primary),
        )
        if (page.primary && !page.recreating) {
            emitGenerationStarted(pendingGenerationStartReason)
        }
        // Sparkling template evaluation does not observe the page entry.
        // Other essentials still come from actual engine loads.
        if (page.logical.entry in page.expectedEssentialResources) {
            launch.resolveEssential(page.logical.entry)
        }
        kit.load()
        return view
    }

    override fun close() {
        requireMainThread()
        if (closed) return
        closed = true
        pageCreatedObserver = null
        pageProgressObserver = null
        val retired = retirementDetails("close")
        generationEvents.beginRetirement(retired)
        pages.forEach(::retirePage)
        pages.clear()
        controller.close()
        generationEvents.finishRetirement(retired)
        ManagedSparklingHostRegistry.remove(hostId, this)
    }

    private fun emitGenerationStarted(reason: String) {
        val primary = pages.firstOrNull() ?: return
        val logicalStack = controller.retainedLogicalStack(primary.session)
        val transitionId = runCatching {
            controller.pendingManagedTransition(primary.session)?.transitionId
        }.getOrNull()
        generationEvents.emit(
            "generationStarted",
            details(primary) + mapOf(
                "contextIds" to pages.mapNotNull { it.diagnostics?.contextId },
                "primaryContextId" to primary.diagnostics?.contextId,
                "reason" to reason,
                "orderedPageEntries" to logicalStack.map { it.entry },
                "orderedPageParameters" to logicalStack.map { it.parameters },
                "topPageEntry" to logicalStack.last().entry,
                "transitionId" to transitionId,
            ),
        )
    }

    private fun retirePage(page: ManagedPage) {
        page.sourceContext?.let { context ->
            ManagedSparklingHostRegistry.unbindContext(context, this)
        }
        page.sourceBridgeContext?.let { context ->
            ManagedSparklingHostRegistry.unbindBridgeContext(context, this)
        }
        page.retire()
    }

    private fun retirementDetails(reason: String): Map<String, Any?> {
        val primary = pages.firstOrNull()
        val identity = primary?.diagnostics
        val logicalStack = primary?.let { page ->
            runCatching {
                controller.retainedLogicalStack(page.session)
            }.getOrNull()
        } ?: pages.map { it.logical }
        val transitionId = primary?.let { page ->
            runCatching {
                controller.pendingManagedTransition(page.session)?.transitionId
            }.getOrNull()
        }
        return mapOf(
            "runtimeId" to configuration.lynx.runtimeId,
            "processId" to currentProcessId(),
            "generationId" to generationEvents.id,
            "contextId" to identity?.contextId,
            "pageAttemptId" to null,
            "contextIds" to pages.mapNotNull { it.diagnostics?.contextId },
            "primaryContextId" to identity?.contextId,
            "attemptId" to identity?.startupAttemptId,
            "bundleId" to (
                identity?.bundleId ?: configuration.lynx.embeddedBundleId
            ),
            "releaseId" to identity?.releaseId,
            "orderedPageEntries" to logicalStack.map { it.entry },
            "orderedPageParameters" to logicalStack.map { it.parameters },
            "topPageEntry" to logicalStack.lastOrNull()?.entry,
            "reason" to reason,
            "transitionId" to transitionId,
        )
    }

    private fun reconstructionFailureDetails(
        session: LynxLaunchSession?,
        retained: List<LynxLogicalPage>,
        transitionId: String?,
        reason: String,
    ): Map<String, Any?> {
        val live = session ?: return retirementDetails(reason)
        val identity = pages.firstOrNull()?.diagnostics
            ?: controller.diagnostics(live)
        return mapOf(
            "runtimeId" to configuration.lynx.runtimeId,
            "processId" to currentProcessId(),
            "generationId" to generationEvents.id,
            "contextId" to identity.contextId,
            "pageAttemptId" to null,
            "contextIds" to pages.mapNotNull { it.diagnostics?.contextId },
            "primaryContextId" to identity.contextId,
            "attemptId" to identity.startupAttemptId,
            "bundleId" to identity.bundleId,
            "releaseId" to identity.releaseId,
            "orderedPageEntries" to retained.map { it.entry },
            "orderedPageParameters" to retained.map { it.parameters },
            "topPageEntry" to retained.lastOrNull()?.entry,
            "reason" to reason,
            "transitionId" to transitionId,
        )
    }

    private fun emitPageAttemptTerminal(
        page: ManagedPage,
        terminal: String,
        reason: String? = null,
        transitionId: String? = null,
        topContextId: String?,
        failureCode: Int? = null,
        failureResourcePath: String? = null,
    ) {
        if (page.primary || page.terminalEmitted) return
        val logicalStack = pages.firstOrNull()?.let { primary ->
            runCatching {
                controller.retainedLogicalStack(primary.session)
            }.getOrNull()
        } ?: pages.map { it.logical }
        val terminalDetails = details(page).toMutableMap().apply {
            put(
                "sourceContextId",
                checkNotNull(page.session.openingSourceContextId),
            )
            put("orderedPageEntries", logicalStack.map { it.entry })
            put("orderedPageParameters", logicalStack.map { it.parameters })
            put(
                "topPageEntry",
                if (terminal == "authorized-cancel") {
                    logicalStack.lastOrNull()?.entry
                } else {
                    page.logical.entry
                },
            )
            put("topContextId", topContextId)
            put("transitionId", transitionId)
            put("terminal", terminal)
            reason?.let { put("reason", it) }
            failureCode?.let { put("failureCode", it) }
            failureResourcePath?.let { put("failureResourcePath", it) }
        }
        if (generationEvents.emitTerminal(terminalDetails)) {
            runCatching {
                controller.markPageAttemptTerminalEventEmitted(identityId(page))
            }.onFailure { error ->
                Log.e(TAG, "Deferred page terminal emission marker", error)
            }
            page.terminalEmitted = true
        }
    }

    private fun identityId(page: ManagedPage) =
        checkNotNull(page.diagnostics).pageAttemptId
            ?: error("A secondary page attempt identity is required")

    private fun details(page: ManagedPage): Map<String, Any?> {
        val identity = page.diagnostics
        return mapOf(
            "runtimeId" to configuration.lynx.runtimeId,
            "processId" to currentProcessId(),
            "generationId" to generationEvents.id,
            "contextId" to identity?.contextId,
            "attemptId" to identity?.startupAttemptId,
            "pageAttemptId" to identity?.pageAttemptId,
            "transitionId" to page.transitionAttribution.id,
            "containerId" to page.containerId,
            "nativePageClass" to (
                page.activity.get()?.javaClass?.name ?: if (page.primary) {
                    null
                } else {
                    HotUpdaterSparklingPageActivity::class.java.name
                }
            ),
            "pageEntry" to page.logical.entry,
            "pageParameters" to page.logical.parameters,
            "bundleId" to identity?.bundleId,
            "releaseId" to identity?.releaseId,
        )
    }

    private fun newController() = LynxUpdaterController(
        applicationContext,
        configuration.lynx,
    )

    private fun transitionError(code: String, message: String) =
        LynxNativeOperationException(code, message)

    private fun requireMainThread() {
        check(Looper.myLooper() == Looper.getMainLooper()) {
            "Managed Lynx generations must be changed on the main thread"
        }
    }

    private fun currentProcessId(): String {
        val processId = Process.myPid()
        check(processId > 0) { "The managed Lynx process identity is invalid" }
        return processId.toString()
    }

    internal data class ManagedPage(
        val id: String,
        val containerId: String,
        val logical: LynxLogicalPage,
        val primary: Boolean,
        val session: LynxLaunchSession,
        var activity: WeakReference<Activity>,
        var diagnostics: LynxLaunchDiagnostics? = null,
        val transitionAttribution: ManagedTransitionAttribution =
            ManagedTransitionAttribution(),
        var sourceContext: Context? = null,
        var sourceBridgeContext: IBridgeContext? = null,
        var sparklingBridge: SparklingBridge? = null,
        var view: HotUpdaterSparklingView? = null,
        var admitted: Boolean = false,
        var firstContentObserved: Boolean = false,
        var expectedEssentialResources: Set<String> = emptySet(),
        val observedEssentialResources: MutableSet<String> = mutableSetOf(),
        var terminalEmitted: Boolean = false,
        var closing: Boolean = false,
        var recreating: Boolean = false,
        var attachFailureReported: Boolean = false,
        var failureHandlerInstalled: Boolean = false,
        val failureGate: RebindFailureGate = RebindFailureGate(),
    ) {
        fun retire() {
            failureGate.close()
            view?.retire()
            view = null
            sourceContext = null
            sourceBridgeContext = null
            sparklingBridge?.release()
            sparklingBridge = null
            session.close()
        }
    }

    companion object {
        private const val TAG = "HotUpdaterSparkling"
        private const val MAX_RECONSTRUCTION_ATTEMPTS = 128
        private const val SPARKLING_LYNX_PLATFORM = 16
    }
}

internal class RebindFailureGate {
    private var rebinding = false
    private var deferred: (() -> Unit)? = null

    fun beginRebind() {
        check(!rebinding)
        rebinding = true
    }

    fun deliver(action: () -> Unit) {
        if (rebinding) {
            check(deferred == null)
            deferred = action
        } else {
            action()
        }
    }

    fun completeRebind() {
        if (!rebinding) return
        rebinding = false
        deferred.also { deferred = null }?.invoke()
    }

    fun close() {
        rebinding = false
        deferred = null
    }
}

internal class ManagedTransitionAttribution {
    var id: String? = null

    fun complete() {
        id = null
    }
}

internal fun routeCloseCause(reason: LynxPageCancelReason) = when (reason) {
    LynxPageCancelReason.NATIVE_BACK -> "back"
    LynxPageCancelReason.SPARKLING_CLOSE -> "router.close"
}

internal fun authorizedSourceBridgeContext(
    supplied: IBridgeContext?,
    bound: IBridgeContext?,
    activity: Activity,
    registeredForHost: Boolean,
    containerId: String,
) = supplied != null && supplied === bound &&
    supplied.containerID == containerId && supplied.ownerActivity === activity &&
    supplied.context?.activity() === activity && registeredForHost

internal fun deliverTransitionAcceptance(
    result: JSONObject,
    completion: (Result<JSONObject>) -> Unit,
    scheduleReplacement: () -> Unit,
) {
    try {
        completion(Result.success(result))
    } finally {
        scheduleReplacement()
    }
}

class HotUpdaterSparklingView internal constructor(
    context: Context,
    private var kit: SimpleLynxKitView?,
) : FrameLayout(context), AutoCloseable {
    init {
        addView(
            checkNotNull(kit),
            LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    internal fun retire() {
        val old = kit ?: return
        kit = null
        old.destroy(true)
        removeView(old)
    }

    override fun close() = retire()
}

internal object ManagedSparklingHostRegistry {
    private val hosts = mutableMapOf<String, WeakReference<HotUpdaterSparklingHost>>()
    private val pageAuthorities =
        mutableMapOf<String, WeakReference<ManagedSparklingPageAuthority>>()
    private val contextAuthorities =
        java.util.IdentityHashMap<Context, WeakReference<HotUpdaterSparklingHost>>()
    private val bridgeAuthorities =
        java.util.IdentityHashMap<
            IBridgeContext,
            WeakReference<ManagedSparklingRouteAuthority>,
        >()

    fun add(id: String, host: HotUpdaterSparklingHost) {
        hosts[id] = WeakReference(host)
        pageAuthorities[id] = WeakReference(host)
    }

    fun remove(id: String, host: HotUpdaterSparklingHost) {
        if (hosts[id]?.get() === host) hosts.remove(id)
        if (pageAuthorities[id]?.get() === host) pageAuthorities.remove(id)
        contextAuthorities.entries.removeAll { it.value.get().let { owner ->
            owner == null || owner === host
        } }
        bridgeAuthorities.entries.removeAll { it.value.get().let { owner ->
            owner == null || owner === host
        } }
    }

    fun host(id: String?) = id?.let { hosts[it]?.get() }

    fun pageAuthority(id: String?) = id?.let { pageAuthorities[it]?.get() }

    fun addPageAuthorityForTest(
        id: String,
        authority: ManagedSparklingPageAuthority,
    ) {
        pageAuthorities[id] = WeakReference(authority)
    }

    fun removePageAuthorityForTest(id: String) {
        pageAuthorities.remove(id)
    }

    fun bindContext(context: Context, host: HotUpdaterSparklingHost) {
        contextAuthorities[context] = WeakReference(host)
    }

    fun unbindContext(context: Context, host: HotUpdaterSparklingHost) {
        if (contextAuthorities[context]?.get() === host) {
            contextAuthorities.remove(context)
        }
    }

    fun hostForContext(context: Context?) = context?.let {
        contextAuthorities[it]?.get()
    }

    fun bindBridgeContext(
        context: IBridgeContext,
        host: ManagedSparklingRouteAuthority,
    ) {
        bridgeAuthorities[context] = WeakReference(host)
    }

    fun unbindBridgeContext(
        context: IBridgeContext,
        host: ManagedSparklingRouteAuthority,
    ) {
        if (bridgeAuthorities[context]?.get() === host) {
            bridgeAuthorities.remove(context)
        }
    }

    fun hostForBridgeContext(context: IBridgeContext?) = context?.let {
        bridgeAuthorities[it]?.get()
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
