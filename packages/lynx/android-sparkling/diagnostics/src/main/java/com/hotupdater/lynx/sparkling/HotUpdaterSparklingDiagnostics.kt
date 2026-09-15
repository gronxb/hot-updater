package com.hotupdater.lynx.sparkling

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Process
import com.hotupdater.lynx.LynxLaunchDiagnostics
import com.hotupdater.lynx.LynxLaunchSession
import com.hotupdater.lynx.LynxUpdaterController
import com.lynx.jsbridge.LynxMethod
import com.lynx.jsbridge.LynxModule
import com.lynx.react.bridge.Callback
import com.lynx.react.bridge.JavaOnlyArray
import com.lynx.react.bridge.JavaOnlyMap
import com.lynx.react.bridge.ReadableMap
import com.tiktok.sparkling.hybridkit.lynx.SparklingLynxModuleWrapper
import com.tiktok.sparkling.method.registry.core.IBridgeContext
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/** QA artifact that is packaged only by the nonproduction matrix application. */
fun HotUpdaterSparklingHost.captureDiagnosticAuthorities() =
    HotUpdaterSparklingStaleProbe(
        pages.mapNotNull { page ->
            val identity = page.diagnostics ?: return@mapNotNull null
            CapturedAuthority(
                controller,
                page.session,
                identity,
                this,
                page.containerId,
                page.sourceBridgeContext,
                page.logical.entry,
                configuration.lynx.runtimeId,
            )
        },
        eventSink,
        generationEvents.id,
    )

/** Uses the same accepted transition path as a production reload. */
fun HotUpdaterSparklingHost.triggerReloadForDiagnostics(
    completion: (Result<JSONObject>) -> Unit,
) {
    reload(generationEvents, "reload", completion)
}

/** Fails the next real public-navigation page before its readiness boundary. */
fun HotUpdaterSparklingHost.armNextPageFatalFailureForDiagnostics(
    message: String = "diagnostic fatal first-load failure",
) {
    check(pageCreatedObserver == null) {
        "A diagnostic page failure is already armed"
    }
    pageCreatedObserver = { page ->
        pageCreatedObserver = null
        check(!page.primary && !page.admitted) {
            "The diagnostic page crossed the admission boundary"
        }
        armFatalFailure(page, message)
    }
}

fun HotUpdaterSparklingHost.armNextPageAdmissionPendingForDiagnostics() {
    check(pageCreatedObserver == null) {
        "A diagnostic page action is already armed"
    }
    pageCreatedObserver = { page ->
        pageCreatedObserver = null
        check(!page.primary && !page.admitted)
        page.session.setReadinessGate { false }
    }
}

fun HotUpdaterSparklingHost.triggerTopPendingAdmissionFailureForDiagnostics() {
    val page = pages.lastOrNull()
        ?.takeIf { !it.primary && !it.admitted }
        ?: error("No pending managed page attempt")
    armFatalFailure(page, "diagnostic fatal first-load failure")
    pageProgressObserver?.invoke(page)
}

fun HotUpdaterSparklingHost.exerciseNavigationStackBoundaryForDiagnostics(
    completion: (Result<JSONObject>) -> Unit,
) {
    val handler = Handler(Looper.getMainLooper())
    val acceptedDepths = mutableListOf<Int>()
    val acceptedContextIds = mutableListOf<String>()
    val before = diagnosticStackSnapshot()
    val pageEntry = pages.first().session.installation.pageEntries
        .firstOrNull { it != pages.first().logical.entry }
        ?: error("A secondary managed page entry is required")

    fun advance() {
        runCatching {
            check(pages.none { !it.primary && !it.admitted }) {
                "The managed stack has a pending page"
            }
            if (pages.size == 16) {
                val beforeRejected = diagnosticStackSnapshot()
                val nativeDepth = pages.size
                val top = pages.last()
                val rejected = runCatching {
                    open(
                        checkNotNull(top.sourceBridgeContext),
                        "hybrid://lynxview_page?bundle=$pageEntry&diagnosticDepth=17",
                        false,
                    )
                }
                check(rejected.isFailure) { "The seventeenth page was accepted" }
                check(
                    rejected.exceptionOrNull()?.message
                        ?.contains("logical stack is full") == true,
                ) { "The seventeenth page did not fail at the stack boundary" }
                val afterRejected = diagnosticStackSnapshot()
                check(beforeRejected.toString() == afterRejected.toString()) {
                    "Rejected page mutated the managed stack"
                }
                completion(Result.success(
                    JSONObject()
                        .put("acceptedDepths", JSONArray(acceptedDepths))
                        .put("acceptedContextIds", JSONArray(acceptedContextIds))
                        .put("rejectionCode", "STACK_LIMIT_EXCEEDED")
                        .put("before", before)
                        .put("beforeRejected", beforeRejected)
                        .put("afterRejected", afterRejected)
                        .put("nativeDepthBeforeRejected", nativeDepth)
                        .put("nativeDepthAfterRejected", pages.size),
                ))
                return
            }
            val top = pages.last()
            val expectedDepth = pages.size + 1
            check(open(
                checkNotNull(top.sourceBridgeContext),
                "hybrid://lynxview_page?bundle=$pageEntry&" +
                    "diagnosticDepth=$expectedDepth",
                false,
            )) { "Managed diagnostic route was rejected" }
            val deadline = android.os.SystemClock.uptimeMillis() + 15_000L
            fun awaitAdmission() {
                val admitted = pages.lastOrNull()?.takeIf {
                        pages.size == expectedDepth && it.admitted &&
                        it.activity.get() != null &&
                        it.sourceBridgeContext != null
                }
                if (admitted != null) {
                    acceptedDepths += expectedDepth
                    acceptedContextIds += checkNotNull(admitted.diagnostics).contextId
                    advance()
                } else if (android.os.SystemClock.uptimeMillis() < deadline) {
                    handler.postDelayed(::awaitAdmission, 10L)
                } else {
                    completion(Result.failure(
                        IllegalStateException("Managed page admission timed out"),
                    ))
                }
            }
            handler.post(::awaitAdmission)
        }.onFailure { completion(Result.failure(it)) }
    }
    advance()
}

private fun HotUpdaterSparklingHost.diagnosticStackSnapshot(): JSONObject {
    val primary = pages.first()
    val logical = controller.retainedLogicalStack(primary.session)
    return JSONObject()
        .put("orderedPageEntries", JSONArray(logical.map { it.entry }))
        .put(
            "orderedPageParameters",
            JSONArray(logical.map { JSONObject(it.parameters) }),
        )
        .put("topPageEntry", logical.last().entry)
        .put(
            "topContextId",
            pages.lastOrNull()?.diagnostics?.contextId ?: JSONObject.NULL,
        )
}

private fun HotUpdaterSparklingHost.armFatalFailure(
    page: HotUpdaterSparklingHost.ManagedPage,
    message: String,
) {
    check(pageProgressObserver == null) {
        "A diagnostic page failure is already pending"
    }
    val generation = generationEvents
    pageProgressObserver = progress@{ candidate ->
        if (candidate !== page) return@progress
        if (
            page.admitted || !page.firstContentObserved ||
            !page.observedEssentialResources.containsAll(
                page.expectedEssentialResources,
            )
        ) return@progress
        pageProgressObserver = null
        check(page.session.recordFatalFailure(message)) {
            "The pending diagnostic page rejected fatal classification"
        }
        recover(message, page, generation)
    }
}

object HotUpdaterSparklingDiagnostics {
    private val staleProbes =
        java.util.WeakHashMap<HotUpdaterSparklingHost, HotUpdaterSparklingStaleProbe>()

    @JvmStatic
    fun modules() = mapOf(
        "HotUpdaterLynxDiagnostics" to SparklingLynxModuleWrapper(
            HotUpdaterLynxDiagnosticsModule::class.java,
        ),
    )

    internal fun capture(host: HotUpdaterSparklingHost) = synchronized(staleProbes) {
        staleProbes[host] = host.captureDiagnosticAuthorities()
    }

    internal fun verify(host: HotUpdaterSparklingHost): Int = synchronized(staleProbes) {
        checkNotNull(staleProbes.remove(host)) {
            "No captured diagnostic authorities"
        }.verifyStaleAuthorities()
    }
}

class HotUpdaterLynxDiagnosticsModule(context: Context) : LynxModule(context) {
    private val runtimeJournal = RuntimeJournalDiagnostics(context.filesDir)
    private val mainThread = DiagnosticMainThreadRunner()

    @LynxMethod
    fun armNextPageFatalFailure(callback: Callback) = replyOnMain(callback) {
        host().armNextPageFatalFailureForDiagnostics()
        JSONObject().put("armed", true)
    }

    @LynxMethod
    fun armNextPageAdmissionPending(callback: Callback) = replyOnMain(callback) {
        host().armNextPageAdmissionPendingForDiagnostics()
        JSONObject().put("armed", true)
    }

    @LynxMethod
    fun triggerTopPendingAdmissionFailure(callback: Callback) = replyOnMain(callback) {
        host().triggerTopPendingAdmissionFailureForDiagnostics()
        JSONObject().put("triggered", true)
    }

    @LynxMethod
    fun triggerReload(callback: Callback) = replyAsyncOnMain(callback) { completion ->
        val host = host()
        HotUpdaterSparklingDiagnostics.capture(host)
        host.triggerReloadForDiagnostics(completion)
    }

    @LynxMethod
    fun captureStaleAuthorities(callback: Callback) = replyOnMain(callback) {
        HotUpdaterSparklingDiagnostics.capture(host())
        JSONObject().put("captured", true)
    }

    @LynxMethod
    fun verifyStaleAuthorities(callback: Callback) = replyOnMain(callback) {
        JSONObject()
            .put("verified", true)
            .put(
                "rejectedCount",
                HotUpdaterSparklingDiagnostics.verify(host()),
            )
    }

    @LynxMethod
    fun installRuntimeJournalFixture(
        params: ReadableMap,
        callback: Callback,
    ) = reply(callback) {
        val mode = params.getString("mode")
            ?: error("Runtime journal fixture mode is required")
        runtimeJournal.install(mode)
        JSONObject().put("mode", mode)
    }

    @LynxMethod
    fun appendRuntimeJournalFixtureEvent(callback: Callback) = reply(callback) {
        runtimeJournal.append()
        JSONObject().put("appended", true)
    }

    @LynxMethod
    fun reopenRuntimeJournalFixture(callback: Callback) = reply(callback) {
        runtimeJournal.reopen()
        JSONObject().put("reopened", true)
    }

    @LynxMethod
    fun getRuntimeJournalFixtureReceipt(callback: Callback) = reply(callback) {
        runtimeJournal.receipt()
    }

    @LynxMethod
    fun restoreRuntimeJournalFixture(callback: Callback) = reply(callback) {
        runtimeJournal.restore()
        JSONObject().put("restored", true)
    }

    @LynxMethod
    fun exerciseRuntimeEventFieldBoundaries(callback: Callback) = reply(callback) {
        runtimeJournal.exerciseFieldBoundaries()
    }

    @LynxMethod
    fun exerciseNavigationStackBoundary(callback: Callback) =
        replyAsyncOnMain(callback) { completion ->
            host().exerciseNavigationStackBoundaryForDiagnostics(completion)
        }

    private fun host() = checkNotNull(
        ManagedSparklingHostRegistry.hostForContext(mContext),
    ) { "No live managed diagnostics context" }

    private fun reply(callback: Callback, operation: () -> JSONObject) {
        callback.invoke(envelope(runCatching(operation)))
    }

    private fun replyOnMain(callback: Callback, operation: () -> JSONObject) {
        mainThread.run<JSONObject>(
            callback = { callback.invoke(envelope(it)) },
            operation = { completion -> completion(runCatching(operation)) },
        )
    }

    private fun replyAsyncOnMain(
        callback: Callback,
        operation: ((Result<JSONObject>) -> Unit) -> Unit,
    ) {
        mainThread.run<JSONObject>(
            callback = { callback.invoke(envelope(it)) },
            operation = operation,
        )
    }

    private fun envelope(result: Result<JSONObject>) = JavaOnlyMap.from(
        result.fold(
            onSuccess = {
                mapOf("ok" to true, "data" to JavaOnlyMap.from(jsonMap(it)))
            },
            onFailure = { error ->
                mapOf(
                    "ok" to false,
                    "error" to JavaOnlyMap.from(
                        mapOf(
                            "code" to "DIAGNOSTIC_REJECTED",
                            "message" to (
                                error.message ?: "Diagnostic action rejected"
                            ),
                        ),
                    ),
                )
            },
        ),
    )

    private fun jsonMap(value: JSONObject): Map<String, Any?> =
        value.keys().asSequence().associateWith { key -> bridge(value.get(key)) }

    private fun bridge(value: Any): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> JavaOnlyMap.from(jsonMap(value))
        is org.json.JSONArray -> JavaOnlyArray.from(
            (0 until value.length()).map { index -> bridge(value.get(index)) },
        )
        else -> value
    }
}

internal class DiagnosticMainThreadRunner(
    private val handler: Handler = Handler(Looper.getMainLooper()),
) {
    fun <T> run(
        callback: (Result<T>) -> Unit,
        operation: ((Result<T>) -> Unit) -> Unit,
    ) {
        val settled = AtomicBoolean()
        dispatch {
            runCatching {
                operation { result ->
                    if (settled.compareAndSet(false, true)) {
                        dispatch { callback(result) }
                    }
                }
            }.onFailure { error ->
                if (settled.compareAndSet(false, true)) {
                    dispatch { callback(Result.failure(error)) }
                }
            }
        }
    }

    private fun dispatch(operation: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            operation()
        } else {
            check(handler.post(operation)) {
                "The diagnostics main-thread operation could not be scheduled"
            }
        }
    }
}

internal data class CapturedAuthority(
    val controller: LynxUpdaterController,
    val session: LynxLaunchSession,
    val identity: LynxLaunchDiagnostics,
    val host: HotUpdaterSparklingHost,
    val containerId: String,
    val sourceBridgeContext: IBridgeContext?,
    val pageEntry: String,
    val runtimeId: String,
)

class HotUpdaterSparklingStaleProbe internal constructor(
    private val authorities: List<CapturedAuthority>,
    private val events: HotUpdaterSparklingEventListener,
    private val generationId: String,
) {
    fun verifyStaleAuthorities(): Int {
        authorities.forEach { authority ->
            val (controller, session, identity) = authority
            val rejected = runCatching {
                controller.diagnostics(session)
            }.isFailure
            check(rejected) { "A retired Lynx context retained live authority" }
            val routeRejected = !authority.host.open(
                authority.sourceBridgeContext,
                "hybrid://lynxview_page?bundle=${authority.pageEntry}",
                false,
            )
            check(routeRejected) { "A retired Lynx route retained live authority" }
            events.onEvent(
                "staleContextRejected",
                mapOf(
                    "runtimeId" to authority.runtimeId,
                    "processId" to diagnosticProcessId(),
                    "identitySource" to "live-diagnostic",
                    "generationId" to generationId,
                    "contextId" to identity.contextId,
                    "attemptId" to identity.startupAttemptId,
                    "pageAttemptId" to identity.pageAttemptId,
                    "transitionId" to null,
                    "bundleId" to identity.bundleId,
                    "releaseId" to identity.releaseId,
                    "code" to "STALE_CONTEXT",
                    "routeRejected" to true,
                    "sourceContainerId" to authority.containerId,
                ),
            )
        }
        return authorities.size
    }
}

private fun diagnosticProcessId(): String {
    val processId = Process.myPid()
    check(processId > 0) { "The managed Lynx process identity is invalid" }
    return processId.toString()
}
