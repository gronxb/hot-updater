package com.hotupdater.lynx

import android.app.Application
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import com.hotupdater.lynx.internal.HashUtils
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.behavior.ui.background.BackgroundLayerDrawable
import com.lynx.tasm.image.ImageContent
import com.lynx.tasm.image.model.AnimationListener
import com.lynx.tasm.image.model.ImageInfo
import com.lynx.tasm.image.model.ImageLoadListener
import com.lynx.tasm.image.model.ImageRequestInfo
import com.lynx.tasm.image.model.ImageRequestInfoBuilder
import com.lynx.tasm.service.ILynxImageService
import com.lynx.tasm.service.ILynxImageServiceExtension
import com.lynx.tasm.service.LynxServiceCenter
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ManagedLynxImageServiceTest {
    @Test
    fun managedSuccessCopiesEveryRequestFieldAndReleaseUsesTranslatedIdentity() {
        withFixture { resources, context, _ ->
            val calls = mutableListOf<String>()
            var translated: ImageRequestInfo? = null
            var delegatedAnimation: AnimationListener? = null
            val released = mutableListOf<ImageRequestInfo>()
            val delegate = imageService { method, arguments ->
                calls += method
                when (method) {
                    "fetchImage" -> {
                        translated = arguments[0] as ImageRequestInfo
                        delegatedAnimation = arguments[2] as AnimationListener?
                        val callback = arguments[1] as ImageLoadListener
                        callback.onRequestSubmit(checkNotNull(translated))
                        callback.onSuccess(
                            null,
                            checkNotNull(translated),
                            ImageInfo(7, 11, false),
                        )
                    }
                    "releaseImage" -> released += arguments[0] as ImageRequestInfo
                }
                null
            }
            val service = managed(delegate, resources, context)
            val animation = animationListener()
            val caller = Any()
            val region = Rect(1, 2, 8, 9)
            val custom = mapOf("request" to "value")
            val builder = ImageRequestInfoBuilder.newBuilderWithSource(MANAGED_URL)
                .setResizeWidth(123)
                .setResizeHeight(456)
                .setLoopCount(2)
                .setBitmapConfig(Bitmap.Config.ARGB_8888)
                .setEnableGifLiteDecoder(true)
                .setCacheChoice(3)
                .setBitmapPostProcessor(emptyList())
                .setEnableResourceHint(true)
                .setEnableDownSampling(false)
                .setUseLocalCache(true)
                .setCallerContext(caller)
                .setEnableAsyncRequest(true)
                .setEnableAnimationAutoPlay(true)
                .setForceStaticImage(true)
                .setEnablePremultiplied(false)
                .setSmoothAnimation(true)
                .setProgressiveRendering(true)
                .setEnableReportInfo(true)
                .setCacheKeyPathOnly(true)
                .setImageSRScale(1.5f)
                .setRegionToDecode(region)
            builder.setCustomParam(custom)
            builder.setDiskCacheChoice(4)
            val original = builder.build()
            val submitted = mutableListOf<ImageRequestInfo>()
            val succeeded = mutableListOf<ImageRequestInfo>()
            val lifecycle = mutableListOf<String>()
            val loaded = mutableListOf<String>()
            resources.onLoaded = { event, path, _ ->
                loaded += "$event:$path"
                lifecycle += "loaded"
            }

            service.fetchImage(
                original,
                imageListener(
                    submitted = submitted,
                    succeeded = succeeded,
                    onSuccess = { lifecycle += "client" },
                ),
                animation,
                context,
            )

            val copy = checkNotNull(translated)
            assertTrue(copy.url.startsWith("file:"))
            assertTrue(File(java.net.URI(copy.url)).isFile)
            assertEquals(original.resizeWidth, copy.resizeWidth)
            assertEquals(original.resizeHeight, copy.resizeHeight)
            assertEquals(original.loopCount, copy.loopCount)
            assertEquals(original.config, copy.config)
            assertEquals(original.isEnableGifLiteDecoder, copy.isEnableGifLiteDecoder)
            assertEquals(original.customParam, copy.customParam)
            assertEquals(original.cacheChoice, copy.cacheChoice)
            assertEquals(original.diskCacheChoice, copy.diskCacheChoice)
            assertSame(original.processors, copy.processors)
            assertEquals(original.isEnableResourceHint, copy.isEnableResourceHint)
            assertEquals(original.isEnableDownSampling, copy.isEnableDownSampling)
            assertEquals(original.isUseLocalCache, copy.isUseLocalCache)
            assertSame(original.callerContext, copy.callerContext)
            assertEquals(original.isEnableAsyncRequest, copy.isEnableAsyncRequest)
            assertEquals(original.isAutoPlay, copy.isAutoPlay)
            assertEquals(original.isForceStaticImage, copy.isForceStaticImage)
            assertEquals(original.isEnablePremultiplied, copy.isEnablePremultiplied)
            assertEquals(original.isEnableSmoothAnimation, copy.isEnableSmoothAnimation)
            assertEquals(
                original.isEnableProgressiveRendering,
                copy.isEnableProgressiveRendering,
            )
            assertEquals(original.isEnableReportInfo, copy.isEnableReportInfo)
            assertEquals(original.isCacheKeyPathOnly, copy.isCacheKeyPathOnly)
            assertEquals(original.imageSRScale, copy.imageSRScale)
            assertSame(original.regionToDecode, copy.regionToDecode)
            assertSame(animation, delegatedAnimation)
            assertEquals(listOf(original), submitted)
            assertEquals(listOf(original), succeeded)
            assertEquals(listOf("imageLoaded:assets/probe.png"), loaded)
            assertEquals(listOf("client", "loaded"), lifecycle)
            assertEquals(1, service.activeRequestCount())

            service.releaseImage(original)

            assertEquals(0, service.activeRequestCount())
            assertEquals(1, released.size)
            assertSame(copy, released.single())
            assertEquals(listOf("fetchImage", "releaseImage"), calls)
        }
    }

    @Test
    fun equalUrlRequestsReleaseTheirOwnTranslatedRequestAfterSuccess() {
        withFixture { resources, context, _ ->
            val translated = mutableListOf<ImageRequestInfo>()
            val callbacks = mutableListOf<ImageLoadListener>()
            val released = mutableListOf<ImageRequestInfo>()
            val delegate = imageService { method, arguments ->
                when (method) {
                    "fetchImage" -> {
                        translated += arguments[0] as ImageRequestInfo
                        callbacks += arguments[1] as ImageLoadListener
                    }
                    "releaseImage" -> released += arguments[0] as ImageRequestInfo
                }
                null
            }
            val service = managed(delegate, resources, context)
            val first = request()
            val second = request()
            assertTrue(first !== second)
            assertEquals(first, second)

            service.fetchImage(first, imageListener(), null, context)
            service.fetchImage(second, imageListener(), null, context)
            callbacks.forEachIndexed { index, callback ->
                callback.onSuccess(null, translated[index], ImageInfo(1, 1, false))
            }

            service.releaseImage(second)
            service.releaseImage(first)

            assertEquals(2, released.size)
            assertSame(translated[1], released[0])
            assertSame(translated[0], released[1])
            assertEquals(0, service.activeRequestCount())
        }
    }

    @Test
    fun redirectedSnapshotUriRemainsManagedByTheOwningRelease() {
        withFixture { resources, context, _ ->
            var delegated: ImageRequestInfo? = null
            var callback: ImageLoadListener? = null
            val delegate = imageService { method, arguments ->
                if (method == "fetchImage") {
                    delegated = arguments[0] as ImageRequestInfo
                    callback = arguments[1] as ImageLoadListener
                }
                null
            }
            val service = managed(delegate, resources, context)
            val snapshotUrl = resources.resolve(MANAGED_URL).toURI().toString()
            val original = ImageRequestInfoBuilder.newBuilderWithSource(snapshotUrl).build()

            service.fetchImage(original, imageListener(), null, context)

            assertEquals(
                File(java.net.URI(snapshotUrl)).toLynxFileUri(),
                checkNotNull(delegated).url,
            )
            checkNotNull(callback).onSuccess(
                null,
                checkNotNull(delegated),
                ImageInfo(1, 1, false),
            )
            assertEquals(1, service.activeRequestCount())
            service.releaseImage(original)
            assertEquals(0, service.activeRequestCount())
        }
    }

    @Test
    fun releaseBeforeCallbackDetachesRoutingButRetainsSnapshotLease() {
        withFixture { resources, context, snapshotRoot ->
            var translated: ImageRequestInfo? = null
            var callback: ImageLoadListener? = null
            val released = mutableListOf<ImageRequestInfo>()
            var clientSuccess = false
            var clientFailure = false
            var observed = false
            var resourceFailure = false
            val delegate = imageService { method, arguments ->
                when (method) {
                    "fetchImage" -> {
                        translated = arguments[0] as ImageRequestInfo
                        callback = arguments[1] as ImageLoadListener
                    }
                    "releaseImage" -> released += arguments[0] as ImageRequestInfo
                }
                null
            }
            var idle = 0
            val service = managed(delegate, resources, context) { idle += 1 }
            val original = request()
            resources.onLoaded = { _, _, _ -> observed = true }
            resources.onFailure = { resourceFailure = true }
            service.fetchImage(
                original,
                imageListener(
                    onSuccess = { clientSuccess = true },
                    onFailure = { clientFailure = true },
                ),
                null,
                context,
            )
            val snapshot = File(java.net.URI(checkNotNull(translated).url))

            service.releaseImage(original)
            service.unregister(context, resources)
            service.releaseOwner(resources)
            resources.isLive = { false }
            resources.close()

            assertEquals(0, service.activeRequestCount())
            assertEquals(1, idle)
            assertSame(translated, released.single())
            assertTrue(snapshot.isFile)
            checkNotNull(callback).onSuccess(
                null,
                checkNotNull(translated),
                ImageInfo(1, 1, false),
            )
            assertFalse(clientSuccess)
            assertFalse(clientFailure)
            assertFalse(observed)
            assertFalse(resourceFailure)
            assertFalse(snapshot.exists())
            assertFalse(snapshotRoot.exists())
            assertEquals(1, idle)
        }
    }

    @Test
    fun missingDecoderCallbackLeavesOnlyColdStartSnapshotOrphan() {
        withFixture { resources, context, snapshotRoot ->
            var translated: ImageRequestInfo? = null
            var callback: ImageLoadListener? = null
            val released = mutableListOf<ImageRequestInfo>()
            val delegate = imageService { method, arguments ->
                when (method) {
                    "fetchImage" -> {
                        translated = arguments[0] as ImageRequestInfo
                        callback = arguments[1] as ImageLoadListener
                    }
                    "releaseImage" -> released += arguments[0] as ImageRequestInfo
                }
                null
            }
            val service = managed(delegate, resources, context)
            val original = request()

            service.fetchImage(original, imageListener(), null, context)
            val snapshot = File(java.net.URI(checkNotNull(translated).url))
            assertTrue(callback != null)

            service.releaseImage(original)
            service.unregister(context, resources)
            service.releaseOwner(resources)
            resources.isLive = { false }
            resources.close()

            assertSame(translated, released.single())
            assertEquals(0, service.activeRequestCount())
            assertTrue(snapshot.isFile)
            callback = null

            val snapshotParent = checkNotNull(snapshotRoot.parentFile)
            LynxReleaseResources.cleanOrphanedSnapshots(snapshotParent)
            assertFalse(snapshotParent.exists())
            assertFalse(snapshot.exists())
        }
    }

    @Test
    fun retirementDiscardsLateSuccessWithoutThrowingAndDrainsLease() {
        withFixture { resources, context, snapshotRoot ->
            var translated: ImageRequestInfo? = null
            var callback: ImageLoadListener? = null
            var clientSuccess = false
            var observed = false
            var resourceFailure = false
            val delegate = imageService { method, arguments ->
                if (method == "fetchImage") {
                    translated = arguments[0] as ImageRequestInfo
                    callback = arguments[1] as ImageLoadListener
                }
                null
            }
            val service = managed(delegate, resources, context)
            var accepting = true
            resources.resourceGate = { operation -> if (accepting) operation() }
            resources.onLoaded = { _, _, _ -> observed = true }
            resources.onFailure = { resourceFailure = true }
            val original = request()
            service.fetchImage(
                original,
                imageListener(onSuccess = { clientSuccess = true }),
                null,
                context,
            )
            val snapshot = File(java.net.URI(checkNotNull(translated).url))
            accepting = false
            resources.isLive = { false }
            resources.close()

            assertTrue(snapshot.isFile)
            checkNotNull(callback).onSuccess(
                null,
                checkNotNull(translated),
                ImageInfo(1, 1, false),
            )

            assertFalse(clientSuccess)
            assertFalse(observed)
            assertFalse(resourceFailure)
            assertFalse(snapshot.exists())
            assertFalse(snapshotRoot.exists())
            assertEquals(1, service.activeRequestCount())
            service.releaseImage(original)
            assertEquals(0, service.activeRequestCount())
        }
    }

    @Test
    fun decoderFailureReportsFailureWithoutMarkingImageLoaded() {
        withFixture { resources, context, _ ->
            val failure = IllegalStateException("decoder failed")
            var translated: ImageRequestInfo? = null
            val released = mutableListOf<ImageRequestInfo>()
            val delegate = imageService { method, arguments ->
                when (method) {
                    "fetchImage" -> {
                        translated = arguments[0] as ImageRequestInfo
                        (arguments[1] as ImageLoadListener).onFailure(123, failure)
                    }
                    "releaseImage" -> released += arguments[0] as ImageRequestInfo
                }
                null
            }
            val service = managed(delegate, resources, context)
            val original = request()
            var clientFailure: Throwable? = null
            var clientFailureCode: Int? = null
            var resourceFailure: String? = null
            var observed = false
            resources.onFailure = { resourceFailure = it }
            resources.onLoaded = { _, _, _ -> observed = true }

            service.fetchImage(
                original,
                object : ImageLoadListener {
                    override fun onRequestSubmit(request: ImageRequestInfo) = Unit
                    override fun onSuccess(
                        image: ImageContent?,
                        request: ImageRequestInfo,
                        info: ImageInfo,
                    ) = Unit

                    override fun onFailure(code: Int, error: Throwable) {
                        clientFailureCode = code
                        clientFailure = error
                    }

                    override fun onImageMonitorInfo(info: org.json.JSONObject) = Unit
                },
                null,
                context,
            )

            assertSame(failure, clientFailure)
            assertEquals(123, clientFailureCode)
            assertEquals("decoder failed", resourceFailure)
            assertFalse(observed)
            assertEquals(1, service.activeRequestCount())

            service.releaseImage(original)

            assertEquals(0, service.activeRequestCount())
            assertSame(translated, released.single())
        }
    }

    @Test
    fun managedSuccessFromWorkerCompletesOnMainExecutorBeforeReadiness() {
        withFixture { resources, context, _ ->
            var translated: ImageRequestInfo? = null
            var callback: ImageLoadListener? = null
            val mainTasks = ArrayDeque<Runnable>()
            val lifecycle = mutableListOf<String>()
            var listenerThread: Thread? = null
            val delegate = imageService { method, arguments ->
                if (method == "fetchImage") {
                    translated = arguments[0] as ImageRequestInfo
                    callback = arguments[1] as ImageLoadListener
                }
                null
            }
            val service = ManagedLynxImageService(
                delegate = delegate,
                executor = Executor(Runnable::run),
                completionExecutor = Executor(mainTasks::addLast),
            ).also {
                it.retainOwner()
                it.register(context, resources)
            }
            resources.onLoaded = { _, _, _ -> lifecycle += "loaded" }
            val original = request()
            service.fetchImage(
                original,
                imageListener(onSuccess = {
                    listenerThread = Thread.currentThread()
                    lifecycle += "client"
                }),
                null,
                context,
            )

            val worker = Thread {
                checkNotNull(callback).onSuccess(
                    null,
                    checkNotNull(translated),
                    ImageInfo(1, 1, false),
                )
            }
            worker.start()
            worker.join()

            assertTrue(lifecycle.isEmpty())
            assertEquals(1, mainTasks.size)
            mainTasks.removeFirst().run()
            assertSame(Thread.currentThread(), listenerThread)
            assertEquals(listOf("client", "loaded"), lifecycle)
            service.releaseImage(original)
            assertEquals(0, service.activeRequestCount())
        }
    }

    @Test
    fun imageServiceExtensionTranslatesManagedBackgroundAndForwardsLifecycle() {
        withFixture { resources, context, snapshotRoot ->
            var detached = 0
            var receivedBounds: Rect? = null
            var receivedState: IntArray? = null
            var receivedVisibility: Pair<Boolean, Boolean>? = null
            var receivedSize: Pair<Int, Int>? = null
            val background = object : BackgroundLayerDrawable() {
                override fun draw(canvas: Canvas) = Unit
                override fun isReady(): Boolean = true
                override fun getImageWidth(): Int = 1
                override fun getImageHeight(): Int = 1
                override fun onAttach() = Unit
                override fun onDetach() {
                    detached += 1
                }

                override fun onSizeChanged(width: Int, height: Int) {
                    receivedSize = width to height
                }

                override fun setBounds(bounds: Rect) {
                    receivedBounds = bounds
                }

                override fun setState(stateSet: IntArray): Boolean {
                    receivedState = stateSet.clone()
                    return true
                }

                override fun setVisible(visible: Boolean, restart: Boolean): Boolean {
                    receivedVisibility = visible to restart
                    return true
                }
            }
            val calls = mutableListOf<String>()
            val urls = mutableListOf<String>()
            val delegate = imageService(withExtension = true) { method, arguments ->
                calls += method
                when (method) {
                    "createBackgroundImageDrawable" -> {
                        assertSame(context, arguments[0])
                        urls += arguments[1] as String
                        background
                    }
                    else -> null
                }
            }
            val service = managed(delegate, resources, context)

            val managedBackground = checkNotNull(
                service.createBackgroundImageDrawable(context, MANAGED_URL),
            )
            assertTrue(managedBackground !== background)
            val bounds = Rect(2, 3, 34, 35)
            managedBackground.javaClass.getDeclaredMethod(
                "onBoundsChange",
                Rect::class.java,
            ).also { it.isAccessible = true }.invoke(managedBackground, bounds)
            managedBackground.javaClass.getDeclaredMethod(
                "onStateChange",
                IntArray::class.java,
            ).also { it.isAccessible = true }.invoke(
                managedBackground,
                intArrayOf(4, 9),
            )
            managedBackground.setVisible(false, true)
            managedBackground.onSizeChanged(32, 33)

            assertSame(bounds, receivedBounds)
            assertArrayEquals(intArrayOf(4, 9), receivedState)
            assertEquals(false to true, receivedVisibility)
            assertEquals(32 to 33, receivedSize)
            assertSame(
                background,
                service.createBackgroundImageDrawable(
                    context,
                    "https://example.test/background.png",
                ),
            )
            service.onLynxEnvSetup()

            assertTrue(urls[0].startsWith("file:///"))
            assertTrue(File(java.net.URI(urls[0])).isFile)
            assertEquals("https://example.test/background.png", urls[1])
            assertEquals(
                listOf(
                    "createBackgroundImageDrawable",
                    "createBackgroundImageDrawable",
                    "onLynxEnvSetup",
                ),
                calls,
            )
            val snapshot = File(java.net.URI(urls[0]))
            resources.close()
            assertTrue(snapshot.isFile)
            managedBackground.onDetach()
            managedBackground.onDetach()
            assertEquals(2, detached)
            assertFalse(snapshot.exists())
            assertFalse(snapshotRoot.exists())
        }
    }

    @Test
    fun unmanagedFetchAndEveryAnimationMethodPassThrough() {
        withFixture { resources, context, _ ->
            val calls = mutableListOf<String>()
            val argumentsByMethod = mutableMapOf<String, Array<out Any?>>()
            val delegate = imageService { method, arguments ->
                calls += method
                argumentsByMethod[method] = arguments
                when (method) {
                    "canParseUrl", "startAnimation", "resumeAnimation",
                    "pauseAnimation", "stopAnimation" -> true
                    else -> null
                }
            }
            val service = managed(delegate, resources, context)
            val remote = ImageRequestInfoBuilder.newBuilderWithSource(
                "https://example.test/image.png",
            ).build()
            val listener = imageListener()
            val animation = animationListener()
            val drawable = ColorDrawable()

            service.fetchImage(remote, listener, animation, context)
            service.releaseImage(remote)
            service.prefetchImage(remote.url, context, mapOf("mode" to "plain"))
            service.prefetchImage(
                remote.url,
                context,
                mapOf("mode" to "observed"),
                listener,
            )
            service.decodeImage(remote, listener)
            assertTrue(service.canParseUrl(remote.url))
            assertTrue(service.startAnimation(drawable))
            assertTrue(service.resumeAnimation(drawable))
            assertTrue(service.pauseAnimation(drawable))
            assertTrue(service.stopAnimation(drawable))
            service.releaseAnimDrawable(drawable)

            assertSame(remote, argumentsByMethod.getValue("fetchImage")[0])
            assertSame(listener, argumentsByMethod.getValue("fetchImage")[1])
            assertSame(animation, argumentsByMethod.getValue("fetchImage")[2])
            assertSame(context, argumentsByMethod.getValue("fetchImage")[3])
            assertSame(remote, argumentsByMethod.getValue("releaseImage")[0])
            listOf(
                "startAnimation",
                "resumeAnimation",
                "pauseAnimation",
                "stopAnimation",
                "releaseAnimDrawable",
            ).forEach { assertSame(drawable, argumentsByMethod.getValue(it)[0]) }
            assertEquals(
                listOf(
                    "fetchImage",
                    "releaseImage",
                    "prefetchImage",
                    "prefetchImage",
                    "decodeImage",
                    "canParseUrl",
                    "startAnimation",
                    "resumeAnimation",
                    "pauseAnimation",
                    "stopAnimation",
                    "releaseAnimDrawable",
                ),
                calls,
            )
        }
    }

    @Test
    fun managedSchemeIsParseableWithoutChangingOrdinaryUrlDecision() {
        withFixture { resources, context, _ ->
            val parsed = mutableListOf<String>()
            val delegate = imageService { method, arguments ->
                if (method == "canParseUrl") {
                    parsed += arguments[0] as String
                    arguments[0] == "https://example.test/supported.png"
                } else {
                    null
                }
            }
            val service = managed(delegate, resources, context)

            assertTrue(service.canParseUrl(MANAGED_URL))
            assertTrue(service.canParseUrl("https://example.test/supported.png"))
            assertFalse(service.canParseUrl("https://example.test/unsupported.png"))
            assertEquals(
                listOf(
                    "https://example.test/supported.png",
                    "https://example.test/unsupported.png",
                ),
                parsed,
            )
        }
    }

    @Test
    fun processInstallerStaysIdleWithoutReinitializingHostAndPreservesReplacement() {
        val center = LynxServiceCenter.inst()
        center.unregisterService(ILynxImageService::class.java)
        var hostInitializations = 0
        val host = imageService { method, _ ->
            if (method == "onInitialize") hostInitializations += 1
            null
        }
        center.registerService(host)
        center.initialize(Application())
        assertEquals(1, hostInitializations)
        val firstRoot = Files.createTempDirectory("lynx-image-owner-one-").toFile()
        val secondRoot = Files.createTempDirectory("lynx-image-owner-two-").toFile()
        try {
            val first = LynxReleaseResources(
                firstRoot,
                "01900000-0000-7000-8000-000000000121",
                emptyMap(),
                firstRoot.resolve("snapshots"),
            )
            val second = LynxReleaseResources(
                secondRoot,
                "01900000-0000-7000-8000-000000000122",
                emptyMap(),
                secondRoot.resolve("snapshots"),
            )

            first.configure(LynxViewBuilder())
            val shared = center.getService(ILynxImageService::class.java)
            assertTrue(shared is ManagedLynxImageService)
            second.configure(LynxViewBuilder())
            assertSame(shared, center.getService(ILynxImageService::class.java))

            first.close()
            assertSame(shared, center.getService(ILynxImageService::class.java))
            second.close()
            assertSame(shared, center.getService(ILynxImageService::class.java))
            second.close()
            assertSame(shared, center.getService(ILynxImageService::class.java))
            assertEquals(1, hostInitializations)

            val externalReplacement = imageService { _, _ -> null }
            val third = LynxReleaseResources(
                firstRoot,
                "01900000-0000-7000-8000-000000000123",
                emptyMap(),
                firstRoot.resolve("third-snapshots"),
            )
            center.registerService(externalReplacement)
            third.configure(LynxViewBuilder())
            val replacementWrapper = center.getService(ILynxImageService::class.java)
            assertTrue(replacementWrapper is ManagedLynxImageService)
            assertSame(
                externalReplacement,
                (replacementWrapper as ManagedLynxImageService).delegate,
            )
            val laterReplacement = imageService { _, _ -> null }
            center.registerService(laterReplacement)
            third.close()
            assertSame(
                laterReplacement,
                center.getService(ILynxImageService::class.java),
            )
            assertEquals(1, hostInitializations)
        } finally {
            center.unregisterService(ILynxImageService::class.java)
            firstRoot.deleteRecursively()
            secondRoot.deleteRecursively()
        }
    }

    @Test
    fun rejectingExecutorFailsRequestAndReleasesLease() {
        withFixture { resources, context, snapshotRoot ->
            val delegatedReleases = mutableListOf<ImageRequestInfo>()
            val delegate = imageService { method, arguments ->
                if (method == "releaseImage") {
                    delegatedReleases += arguments[0] as ImageRequestInfo
                }
                null
            }
            val service = ManagedLynxImageService(
                delegate = delegate,
                executor = Executor { throw RejectedExecutionException("rejected") },
            )
            service.retainOwner()
            service.register(context, resources)
            var failures = 0
            var resourceFailures = 0
            resources.onFailure = { resourceFailures += 1 }

            val original = request()
            service.fetchImage(
                original,
                imageListener(onFailure = { failures += 1 }),
                null,
                context,
            )
            assertEquals(1, failures)
            assertEquals(1, resourceFailures)
            assertEquals(1, service.activeRequestCount())

            service.releaseImage(original)
            resources.close()

            assertEquals(0, service.activeRequestCount())
            assertTrue(delegatedReleases.isEmpty())
            assertFalse(snapshotRoot.exists())
        }
    }

    private fun managed(
        delegate: ILynxImageService,
        resources: LynxReleaseResources,
        context: ContextWrapper,
        onIdle: (ManagedLynxImageService) -> Unit = {},
    ): ManagedLynxImageService = ManagedLynxImageService(
        delegate = delegate,
        executor = Executor(Runnable::run),
        completionExecutor = Executor(Runnable::run),
        onIdle = onIdle,
    ).also {
        it.retainOwner()
        it.register(context, resources)
    }

    private fun request(): ImageRequestInfo =
        ImageRequestInfoBuilder.newBuilderWithSource(MANAGED_URL).build()

    private fun withFixture(
        block: (
            LynxReleaseResources,
            ContextWrapper,
            File,
        ) -> Unit,
    ) {
        val root = Files.createTempDirectory("lynx-image-service-").toFile()
        try {
            val image = root.resolve("assets/probe.png").apply {
                parentFile.mkdirs()
                writeBytes(byteArrayOf(1, 2, 3, 4))
            }
            val snapshotRoot = root.resolve("snapshots/context-1")
            block(
                LynxReleaseResources(
                    root,
                    "01900000-0000-7000-8000-000000000121",
                    mapOf("assets/probe.png" to HashUtils.calculateSHA256(image)),
                    snapshotRoot,
                ),
                ContextWrapper(null),
                snapshotRoot,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    private fun imageService(
        withExtension: Boolean = false,
        invocation: (String, Array<out Any?>) -> Any?,
    ): ILynxImageService = Proxy.newProxyInstance(
        ILynxImageService::class.java.classLoader,
        if (withExtension) {
            arrayOf(
                ILynxImageService::class.java,
                ILynxImageServiceExtension::class.java,
            )
        } else {
            arrayOf(ILynxImageService::class.java)
        },
    ) { _, method, arguments ->
        if (method.name == "getServiceClass") return@newProxyInstance ILynxImageService::class.java
        invocation(method.name, arguments ?: emptyArray()) ?: when (method.returnType) {
            java.lang.Boolean.TYPE -> false
            java.lang.Integer.TYPE -> 0
            else -> null
        }
    } as ILynxImageService

    private fun imageListener(
        submitted: MutableList<ImageRequestInfo> = mutableListOf(),
        succeeded: MutableList<ImageRequestInfo> = mutableListOf(),
        onSuccess: () -> Unit = {},
        onFailure: () -> Unit = {},
    ) = object : ImageLoadListener {
        override fun onRequestSubmit(request: ImageRequestInfo) {
            submitted += request
        }

        override fun onSuccess(
            image: ImageContent?,
            request: ImageRequestInfo,
            info: ImageInfo,
        ) {
            succeeded += request
            onSuccess()
        }

        override fun onFailure(code: Int, error: Throwable) = onFailure()

        override fun onImageMonitorInfo(info: org.json.JSONObject) = Unit
    }

    private fun animationListener() = object : AnimationListener {
        override fun onAnimationStart(drawable: android.graphics.drawable.Drawable) = Unit

        override fun onAnimationFinalLoop(drawable: android.graphics.drawable.Drawable) = Unit

        override fun onAnimationCurrentLoop(drawable: android.graphics.drawable.Drawable) = Unit
    }

    private companion object {
        const val MANAGED_URL = "hot-updater:///assets/probe.png"
    }
}
