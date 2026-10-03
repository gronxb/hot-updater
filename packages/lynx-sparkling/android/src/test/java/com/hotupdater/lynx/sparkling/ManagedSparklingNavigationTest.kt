package com.hotupdater.lynx.sparkling

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Looper
import android.view.View
import com.hotupdater.lynx.LynxPageCancelReason
import com.lynx.jsbridge.ParamWrapper
import com.lynx.tasm.LynxViewBuilder
import com.tiktok.sparkling.method.registry.api.SparklingBridge
import com.tiktok.sparkling.method.registry.core.BridgePlatformType
import com.tiktok.sparkling.method.registry.core.IBridgeContext
import com.tiktok.sparkling.method.registry.core.IDLBridgeMethod
import com.tiktok.sparkling.method.registry.core.SparklingBridgeManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.Shadows.shadowOf
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ManagedSparklingNavigationTest {
    private val pages = setOf("main.lynx.bundle", "detail.lynx.bundle")

    @Test
    fun replacementWaitsForRuntimeDetachAndDispatchesCompletionOnce() {
        val dispatched = ArrayDeque<() -> Unit>()
        val lifecycle = ManagedRuntimeLifecycle(dispatched::addLast)
        var completions = 0

        lifecycle.whenDetached { completions += 1 }
        lifecycle.onRuntimeDetach()

        assertEquals(0, completions)
        dispatched.removeFirst().invoke()
        assertEquals(1, completions)

        lifecycle.onRuntimeDetach()
        assertTrue(dispatched.isEmpty())
        assertEquals(1, completions)
    }

    @Test
    fun runtimeDetachedBeforeRetirementStillDispatchesCompletion() {
        val dispatched = ArrayDeque<() -> Unit>()
        val lifecycle = ManagedRuntimeLifecycle(dispatched::addLast)
        var completions = 0

        lifecycle.onRuntimeDetach()
        lifecycle.whenDetached { completions += 1 }

        assertEquals(0, completions)
        dispatched.removeFirst().invoke()
        assertEquals(1, completions)
    }

    @Test
    fun destroyedViewDispatchesCompletionWhenRuntimeDetachIsNotReported() {
        val dispatched = ArrayDeque<() -> Unit>()
        val lifecycle = ManagedRuntimeLifecycle(dispatched::addLast)
        var completions = 0

        lifecycle.whenDetached { completions += 1 }
        lifecycle.onViewDestroyed()

        assertEquals(0, completions)
        dispatched.removeFirst().invoke()
        assertEquals(1, completions)

        lifecycle.onRuntimeDetach()
        assertTrue(dispatched.isEmpty())
        assertEquals(1, completions)
    }

    @Test
    fun resourceFailureDuringConfigurationRebindRecoversExactlyOnceAfterAttach() {
        val gate = RebindFailureGate()
        var recoveries = 0

        gate.beginRebind()
        gate.deliver { recoveries += 1 }
        assertEquals(0, recoveries)

        gate.completeRebind()
        gate.completeRebind()
        assertEquals(1, recoveries)
    }

    @Test
    fun routeCloseCauseAndPendingTerminalReasonRemainDistinct() {
        assertEquals("back", routeCloseCause(LynxPageCancelReason.NATIVE_BACK))
        assertEquals("nativeBack", LynxPageCancelReason.NATIVE_BACK.wireValue)
        assertEquals(
            "router.close",
            routeCloseCause(LynxPageCancelReason.SPARKLING_CLOSE),
        )
        assertEquals(
            "sparklingClose",
            LynxPageCancelReason.SPARKLING_CLOSE.wireValue,
        )
    }

    @Test
    fun acceptedTransitionSchedulesReplacementWhenBridgeCompletionThrows() {
        val accepted = JSONObject()
            .put("status", "TRANSITION_ACCEPTED")
            .put("transitionId", "transition-a")
        var replacements = 0

        val failure = assertThrows(IllegalStateException::class.java) {
            deliverTransitionAcceptance(
                accepted,
                completion = { result ->
                    assertEquals("TRANSITION_ACCEPTED", result.getOrThrow().getString("status"))
                    error("destroyed bridge callback")
                },
                scheduleReplacement = { replacements += 1 },
            )
        }

        assertEquals("destroyed bridge callback", failure.message)
        assertEquals(1, replacements)
    }

    @Test
    fun acceptedTransitionAttributionEndsAfterTheCompletionEvent() {
        val transition = ManagedTransitionAttribution().apply {
            id = "transition-a"
        }

        // Primary jsReady reads the accepted transition before completing it.
        assertEquals("transition-a", transition.id)
        transition.complete()

        // Later resource and configuration-recreation events have no accepted
        // transition to attribute after that completion.
        assertEquals(null, transition.id)
    }

    @Test
    fun acceptsOnlyTheCanonicalLockedNavigateRoute() {
        val route = ManagedSparklingRoute.parse(
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&" +
                "title=Second+Page&value=a%2Bb",
            pages,
        )

        assertEquals("detail.lynx.bundle", route.pageEntry)
        assertEquals(
            linkedMapOf("title" to "Second Page", "value" to "a+b"),
            route.parameters,
        )
    }

    @Test
    fun acceptsExactRouteAndParameterBoundsAndRejectsOneBeyondEach() {
        val base = "hybrid://lynxview_page?bundle=detail.lynx.bundle&a="
        val encoded = "%C3%A9".repeat(512)
        val secondPrefix = "&b="
        val padding = "x".repeat(4096 - base.length - encoded.length - secondPrefix.length)
        val exactRoute = base + encoded + secondPrefix + padding
        assertEquals(4096, exactRoute.toByteArray(Charsets.UTF_8).size)
        ManagedSparklingRoute.parse(exactRoute, pages)
        assertThrows(IllegalArgumentException::class.java) {
            ManagedSparklingRoute.parse(exactRoute + "x", pages)
        }

        val exactCount = (1..32).joinToString("&", prefix = "&") { "p$it=" }
        ManagedSparklingRoute.parse(
            "hybrid://lynxview_page?bundle=detail.lynx.bundle$exactCount",
            pages,
        )
        assertThrows(IllegalArgumentException::class.java) {
            ManagedSparklingRoute.parse(
                "hybrid://lynxview_page?bundle=detail.lynx.bundle" +
                    (1..33).joinToString("&", prefix = "&") { "p$it=" },
                pages,
            )
        }

        val exactKey = "k".repeat(128)
        ManagedSparklingRoute.parse(
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&$exactKey=v",
            pages,
        )
        assertThrows(IllegalArgumentException::class.java) {
            ManagedSparklingRoute.parse(
                "hybrid://lynxview_page?bundle=detail.lynx.bundle&${exactKey}k=v",
                pages,
            )
        }

        val exactValue = "v".repeat(1024)
        ManagedSparklingRoute.parse(
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&k=$exactValue",
            pages,
        )
        assertThrows(IllegalArgumentException::class.java) {
            ManagedSparklingRoute.parse(
                "hybrid://lynxview_page?bundle=detail.lynx.bundle&k=${exactValue}v",
                pages,
            )
        }

        val aggregateValue = "a".repeat(1011)
        val exactAggregate =
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&a=$aggregateValue" +
                "&b=$aggregateValue"
        ManagedSparklingRoute.parse(exactAggregate, pages)
        assertThrows(IllegalArgumentException::class.java) {
            ManagedSparklingRoute.parse(exactAggregate + "a", pages)
        }

        val exactBundle = "a".repeat(1012) + ".lynx.bundle"
        ManagedSparklingRoute.parse(
            "hybrid://lynxview_page?bundle=$exactBundle",
            setOf(exactBundle),
        )
        val oversizeBundle = "a$exactBundle"
        assertThrows(IllegalArgumentException::class.java) {
            ManagedSparklingRoute.parse(
                "hybrid://lynxview_page?bundle=$oversizeBundle",
                setOf(oversizeBundle),
            )
        }
    }

    @Test
    fun rejectsRouteAliasesAndUnmanagedPagesBeforeOpeningAContext() {
        listOf(
            "Hybrid://lynxview_page?bundle=detail.lynx.bundle",
            "hybrid://LYNXVIEW_PAGE?bundle=detail.lynx.bundle",
            "hybrid://lynxview_page/?bundle=detail.lynx.bundle",
            "hybrid://lynxview_page?title=x&bundle=detail.lynx.bundle",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&bundle=main.lynx.bundle",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&url=https%3A%2F%2Fexample.com",
            "hybrid://lynxview_page?bundle=%64etail.lynx.bundle",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&title=Second%20Page",
            "hybrid://lynxview_page?bundle=%252f",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&replace=false",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&title=a&title=b",
            "hybrid://lynxview_page?bundle=detail.lynx.bundle&=x",
            "hybrid://lynxview_page?bundle=missing.lynx.bundle",
            "hybrid://lynxview_page?bundle=pages%2Fdetail.lynx.bundle",
            "hybrid://lynxview_page?bundle=../detail.lynx.bundle",
        ).forEach { value ->
            assertThrows(value, IllegalArgumentException::class.java) {
                ManagedSparklingRoute.parse(value, pages)
            }
        }
    }

    @Test
    fun nativeOpenOptionsAreClosedAndAnimationIsPresentationOnly() {
        val (scheme, defaults) = ManagedOpenOptions.parse(
            mapOf("scheme" to "hybrid://lynxview_page?bundle=detail.lynx.bundle"),
        )
        assertEquals(
            "hybrid://lynxview_page?bundle=detail.lynx.bundle",
            scheme,
        )
        assertTrue(defaults.animated)
        assertFalse(
            ManagedOpenOptions.parse(
                mapOf(
                    "scheme" to scheme,
                    "replace" to false,
                    "useSysBrowser" to false,
                    "animated" to false,
                ),
            ).second.animated,
        )

        listOf(
            mapOf("scheme" to scheme, "replace" to true),
            mapOf("scheme" to scheme, "replaceType" to "top"),
            mapOf("scheme" to scheme, "useSysBrowser" to true),
            mapOf("scheme" to scheme, "interceptor" to "native"),
            mapOf("scheme" to scheme, "extra" to emptyMap<String, String>()),
            mapOf("scheme" to scheme, "unknown" to false),
            mapOf("scheme" to scheme, "animated" to "false"),
            mapOf("scheme" to scheme, "animated" to null),
        ).forEach { options ->
            assertThrows(IllegalArgumentException::class.java) {
                ManagedOpenOptions.parse(options)
            }
        }
    }

    @Test
    fun nativeCloseOptionsRejectNullAndPreserveFalseAnimation() {
        assertFalse(
            ManagedCloseOptions.parse(
                mapOf("containerID" to "detail", "animated" to false),
            ).animated,
        )
        listOf(
            mapOf<String, Any?>("containerID" to null),
            mapOf<String, Any?>("animated" to null),
            mapOf<String, Any?>("animated" to "false"),
            mapOf<String, Any?>("unknown" to false),
        ).forEach { options ->
            assertThrows(IllegalArgumentException::class.java) {
                ManagedCloseOptions.parse(options)
            }
        }
    }

    @Test
    fun registrationPublishesManagedMethodsOnTheSparklingPipeRegistry() {
        ManagedSparklingBridge.register()

        val lynxMethods = SparklingBridgeManager.getIDLMethodList(
            BridgePlatformType.LYNX,
            SparklingBridgeManager.DEFAULT_NAMESPACE,
        )
        val allMethods = SparklingBridgeManager.getIDLMethodList(
            BridgePlatformType.ALL,
            SparklingBridgeManager.DEFAULT_NAMESPACE,
        )

        assertEquals(
            "lynx=${lynxMethods?.keys}; all=${allMethods?.keys}",
            ManagedRouterOpenMethod::class.java,
            lynxMethods?.get("router.open"),
        )
        assertEquals(
            ManagedRouterCloseMethod::class.java,
            SparklingBridgeManager.findIDLMethodClass(
                BridgePlatformType.LYNX,
                "router.close",
                SparklingBridgeManager.DEFAULT_NAMESPACE,
            ),
        )
    }

    @Test
    fun packagedPageActivityIsARealNonExportedActivity() {
        val application = RuntimeEnvironment.getApplication()
        val component = ComponentName(
            application,
            HotUpdaterSparklingPageActivity::class.java,
        )
        val info = application.packageManager.getActivityInfo(
            component,
            0,
        )

        assertFalse(info.exported)
        val requiredConfigChanges =
            ActivityInfo.CONFIG_ORIENTATION or
                ActivityInfo.CONFIG_SCREEN_SIZE or
                ActivityInfo.CONFIG_UI_MODE or
                ActivityInfo.CONFIG_LOCALE or
                ActivityInfo.CONFIG_DENSITY
        assertEquals(
            requiredConfigChanges,
            info.configChanges and requiredConfigChanges,
        )
        assertTrue(
            android.app.Activity::class.java.isAssignableFrom(
                HotUpdaterSparklingPageActivity::class.java,
            ),
        )
    }

    @Test
    fun actualActivityRecreationBindsAFreshAuthorityForSubsequentBackRoute() {
        val application = RuntimeEnvironment.getApplication()
        val hostId = "configuration-host"
        val authority = object : ManagedSparklingPageAuthority {
            lateinit var attachedActivity: HotUpdaterSparklingPageActivity
            var backs = 0
            var attaches = 0

            override fun attachPage(
                pageId: String,
                activity: HotUpdaterSparklingPageActivity,
            ): View {
                assertEquals("configuration-page", pageId)
                attachedActivity = activity
                attaches += 1
                return View(activity)
            }

            override fun requestBack(activity: android.app.Activity): Boolean {
                assertSame(attachedActivity, activity)
                backs += 1
                return true
            }

            override fun activityDetached(activity: android.app.Activity) = Unit

            override fun pageAttachFailed(
                pageId: String,
                activity: HotUpdaterSparklingPageActivity,
                error: Throwable,
            ) = Unit
        }
        ManagedSparklingHostRegistry.addPageAuthorityForTest(hostId, authority)
        try {
            val intent = Intent(
                application,
                HotUpdaterSparklingPageActivity::class.java,
            )
                .putExtra(HotUpdaterSparklingPageActivity.EXTRA_HOST_ID, hostId)
                .putExtra(
                    HotUpdaterSparklingPageActivity.EXTRA_PAGE_ID,
                    "configuration-page",
                )
            val controller = Robolectric.buildActivity(
                HotUpdaterSparklingPageActivity::class.java,
                intent,
            )
            controller.setup()
            val firstActivity = controller.get()
            controller.recreate()
            val recreatedActivity = controller.get()
            assertFalse(firstActivity === recreatedActivity)
            assertSame(recreatedActivity, authority.attachedActivity)
            assertEquals(2, authority.attaches)
            recreatedActivity.onBackPressedDispatcher.onBackPressed()
            assertEquals(1, authority.backs)
        } finally {
            ManagedSparklingHostRegistry.removePageAuthorityForTest(hostId)
        }
    }

    @Test
    fun pinnedBridgeInstallsSpkPipeAndRoutesOnlyFromItsExactContext() {
        val activity = Robolectric.buildActivity(android.app.Activity::class.java)
            .setup().get()
        val mainBridge = SparklingBridge()
        val detailBridge = SparklingBridge()
        val forgedBridge = SparklingBridge()
        val recreatedMainBridge = SparklingBridge()
        val authority = RecordingRouteAuthority()
        try {
            val mainView = View(activity)
            val detailView = View(activity)
            val forgedView = View(activity)
            val recreatedMainView = View(activity)
            val mainBuilder = LynxViewBuilder()
            mainBridge.registerLynxModule(mainBuilder, "main-container")
            mainBridge.init(mainView, "main-container", 16)
            detailBridge.registerLynxModule(
                LynxViewBuilder(),
                "detail-container",
            )
            detailBridge.init(detailView, "detail-container", 16)
            forgedBridge.init(forgedView, "detail-container", 16)
            val main = mainBridge.getBridgeSDKContext()
            val detail = detailBridge.getBridgeSDKContext()
            val forged = forgedBridge.getBridgeSDKContext()

            assertEquals(
                listOf("spkPipe"),
                registeredModuleNames(mainBuilder).filter { it == "spkPipe" },
            )
            assertSame(activity, main.context)
            assertSame(activity, main.ownerActivity)
            assertEquals("main-container", main.containerID)
            assertTrue(
                authorizedSourceBridgeContext(
                    main,
                    main,
                    activity,
                    true,
                    "main-container",
                ),
            )
            assertFalse(
                authorizedSourceBridgeContext(
                    forged,
                    detail,
                    activity,
                    true,
                    "detail-container",
                ),
            )

            ManagedSparklingHostRegistry.bindBridgeContext(main, authority)
            ManagedSparklingHostRegistry.bindBridgeContext(detail, authority)
            val openResult = invokeRouter(
                ManagedRouterOpenMethod(),
                main,
                mapOf(
                    "scheme" to
                        "hybrid://lynxview_page?bundle=detail.lynx.bundle",
                    "animated" to false,
                ),
            )
            val closeResult = invokeRouter(
                ManagedRouterCloseMethod(),
                detail,
                mapOf("containerID" to "detail-container", "animated" to false),
            )
            val forgedResult = invokeRouter(
                ManagedRouterCloseMethod(),
                forged,
                mapOf("containerID" to "detail-container"),
            )

            assertEquals(IDLBridgeMethod.SUCCESS, openResult["code"])
            assertEquals(IDLBridgeMethod.SUCCESS, closeResult["code"])
            assertEquals(IDLBridgeMethod.INVALID_PARAM, forgedResult["code"])
            assertSame(main, authority.openSource)
            assertFalse(authority.openAnimated ?: true)
            assertSame(detail, authority.closeSource)
            assertEquals("detail-container", authority.closeContainerId)
            assertFalse(authority.closeAnimated ?: true)

            ManagedSparklingHostRegistry.unbindBridgeContext(main, authority)
            recreatedMainBridge.init(recreatedMainView, "main-container", 16)
            val recreatedMain = recreatedMainBridge.getBridgeSDKContext()
            ManagedSparklingHostRegistry.bindBridgeContext(
                recreatedMain,
                authority,
            )
            val retiredResult = invokeRouter(
                ManagedRouterOpenMethod(),
                main,
                mapOf(
                    "scheme" to
                        "hybrid://lynxview_page?bundle=detail.lynx.bundle",
                ),
            )
            val recreatedResult = invokeRouter(
                ManagedRouterOpenMethod(),
                recreatedMain,
                mapOf(
                    "scheme" to
                        "hybrid://lynxview_page?bundle=detail.lynx.bundle",
                ),
            )
            assertEquals(IDLBridgeMethod.INVALID_PARAM, retiredResult["code"])
            assertEquals(IDLBridgeMethod.SUCCESS, recreatedResult["code"])
        } finally {
            runCatching {
                ManagedSparklingHostRegistry.unbindBridgeContext(
                    mainBridge.getBridgeSDKContext(),
                    authority,
                )
            }
            runCatching {
                ManagedSparklingHostRegistry.unbindBridgeContext(
                    detailBridge.getBridgeSDKContext(),
                    authority,
                )
            }
            runCatching {
                ManagedSparklingHostRegistry.unbindBridgeContext(
                    recreatedMainBridge.getBridgeSDKContext(),
                    authority,
                )
            }
            recreatedMainBridge.release()
            forgedBridge.release()
            detailBridge.release()
            mainBridge.release()
        }
    }

    @Test
    @LooperMode(LooperMode.Mode.PAUSED)
    fun routerCallsFromBridgeThreadsRunOnTheMainLooper() {
        val activity = Robolectric.buildActivity(android.app.Activity::class.java)
            .setup().get()
        val bridge = SparklingBridge()
        val authority = RecordingRouteAuthority()
        try {
            bridge.registerLynxModule(LynxViewBuilder(), "main-container")
            bridge.init(View(activity), "main-container", 16)
            val context = bridge.getBridgeSDKContext()
            ManagedSparklingHostRegistry.bindBridgeContext(context, authority)
            val callbackResult = AtomicReference<Map<String, Any?>?>()
            val method = ManagedRouterOpenMethod().apply {
                setBridgeContext(context)
            }

            Thread {
                method.realHandle(
                    mapOf(
                        "scheme" to
                            "hybrid://lynxview_page?bundle=detail.lynx.bundle",
                    ),
                    object : IDLBridgeMethod.Callback {
                        override fun invoke(data: Map<String, Any?>) {
                            callbackResult.set(data)
                        }
                    },
                    BridgePlatformType.LYNX,
                )
            }.apply {
                start()
                join()
            }

            assertNull(callbackResult.get())
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(IDLBridgeMethod.SUCCESS, callbackResult.get()?.get("code"))
            assertSame(Looper.getMainLooper(), authority.openLooper)
        } finally {
            runCatching {
                ManagedSparklingHostRegistry.unbindBridgeContext(
                    bridge.getBridgeSDKContext(),
                    authority,
                )
            }
            bridge.release()
        }
    }

    private fun registeredModuleNames(builder: LynxViewBuilder): List<String> {
        val wrappers = builder.lynxRuntimeOptions.javaClass
            .getDeclaredField("mWrappers")
            .apply { isAccessible = true }
            .get(builder.lynxRuntimeOptions) as List<*>
        return wrappers.filterIsInstance<ParamWrapper>().map { it.name }
    }

    private fun invokeRouter(
        method: IDLBridgeMethod,
        context: IBridgeContext,
        params: Map<String, Any?>,
    ): Map<String, Any?> {
        var result: Map<String, Any?>? = null
        method.setBridgeContext(context)
        method.realHandle(
            params,
            object : IDLBridgeMethod.Callback {
                override fun invoke(data: Map<String, Any?>) {
                    result = data
                }
            },
            BridgePlatformType.LYNX,
        )
        return checkNotNull(result)
    }

    private class RecordingRouteAuthority : ManagedSparklingRouteAuthority {
        var openSource: IBridgeContext? = null
        var openAnimated: Boolean? = null
        var openLooper: Looper? = null
        var closeSource: IBridgeContext? = null
        var closeContainerId: String? = null
        var closeAnimated: Boolean? = null

        override fun open(
            sourceBridgeContext: IBridgeContext?,
            scheme: String,
            animated: Boolean,
        ): Boolean {
            openSource = sourceBridgeContext
            openAnimated = animated
            openLooper = Looper.myLooper()
            return true
        }

        override fun close(
            sourceBridgeContext: IBridgeContext?,
            requestedContainerId: String?,
            animated: Boolean,
        ): Boolean {
            closeSource = sourceBridgeContext
            closeContainerId = requestedContainerId
            closeAnimated = animated
            return true
        }
    }

    @Test
    fun pageActivityReportsSynchronousAttachFailureOnceAndFinishes() {
        val application = RuntimeEnvironment.getApplication()
        val hostId = "failing-attach-host"
        val failure = IllegalStateException("kit construction failed")
        var reported = 0
        val authority = object : ManagedSparklingPageAuthority {
            override fun attachPage(
                pageId: String,
                activity: HotUpdaterSparklingPageActivity,
            ): View = throw failure

            override fun requestBack(activity: android.app.Activity) = false

            override fun activityDetached(activity: android.app.Activity) = Unit

            override fun pageAttachFailed(
                pageId: String,
                activity: HotUpdaterSparklingPageActivity,
                error: Throwable,
            ) {
                assertEquals("failing-page", pageId)
                assertSame(failure, error)
                reported += 1
            }
        }
        ManagedSparklingHostRegistry.addPageAuthorityForTest(hostId, authority)
        try {
            val intent = Intent(
                application,
                HotUpdaterSparklingPageActivity::class.java,
            )
                .putExtra(HotUpdaterSparklingPageActivity.EXTRA_HOST_ID, hostId)
                .putExtra(HotUpdaterSparklingPageActivity.EXTRA_PAGE_ID, "failing-page")
            val activity = Robolectric.buildActivity(
                HotUpdaterSparklingPageActivity::class.java,
                intent,
            ).setup().get()

            assertTrue(activity.isFinishing)
            assertEquals(1, reported)
        } finally {
            ManagedSparklingHostRegistry.removePageAuthorityForTest(hostId)
        }
    }
}
