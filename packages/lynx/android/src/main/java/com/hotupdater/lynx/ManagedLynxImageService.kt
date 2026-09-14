package com.hotupdater.lynx

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Path
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import com.lynx.tasm.LynxSubErrorCode
import com.lynx.tasm.behavior.ui.LynxBaseUI
import com.lynx.tasm.behavior.ui.background.BackgroundLayerDrawable
import com.lynx.tasm.core.LynxThreadPool
import com.lynx.tasm.image.ImageContent
import com.lynx.tasm.image.model.AnimationListener
import com.lynx.tasm.image.model.ImageInfo
import com.lynx.tasm.image.model.ImageLoadListener
import com.lynx.tasm.image.model.ImageRequestInfo
import com.lynx.tasm.image.model.ImageRequestInfoBuilder
import com.lynx.tasm.service.ILynxImageService
import com.lynx.tasm.service.ILynxImageServiceExtension
import com.lynx.tasm.service.LynxServiceCenter
import java.util.IdentityHashMap
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

/** Keeps Lynx's complete image service contract while translating managed URLs. */
internal class ManagedLynxImageService(
    internal val delegate: ILynxImageService,
    private val executor: Executor = Executor { command ->
        LynxThreadPool.getBriefIOExecutor().execute(command)
    },
    private val completionExecutor: Executor = MainThreadExecutor,
    private val onIdle: (ManagedLynxImageService) -> Unit = {},
) : ILynxImageService by delegate, ILynxImageServiceExtension {
    private val lock = Any()
    private val contexts = IdentityHashMap<Context, LynxReleaseResources>()
    private val requests = IdentityHashMap<ImageRequestInfo, ManagedRequest>()
    private var owners = 0
    private var idleNotified = false

    override fun onInitialize(context: Context) = Unit

    internal fun retainOwner() = synchronized(lock) {
        idleNotified = false
        owners += 1
    }

    internal fun register(
        context: Context,
        resources: LynxReleaseResources,
    ) = synchronized(lock) {
        check(contexts.put(context, resources) == null) {
            "Lynx image context is already registered"
        }
    }

    internal fun unregister(
        context: Context,
        resources: LynxReleaseResources,
    ) {
        synchronized(lock) {
            if (contexts[context] === resources) contexts.remove(context)
        }
        cancel(resources)
        checkIdle()
    }

    internal fun releaseOwner(resources: LynxReleaseResources) {
        cancel(resources)
        synchronized(lock) {
            owners -= 1
            check(owners >= 0)
        }
        checkIdle()
    }

    override fun fetchImage(
        request: ImageRequestInfo,
        listener: ImageLoadListener,
        animationListener: AnimationListener?,
        context: Context,
    ) {
        val resources = synchronized(lock) { contexts[context] }
        if (resources == null || !resources.owns(request.url)) {
            delegate.fetchImage(request, listener, animationListener, context)
            return
        }

        val lease = try {
            resources.beginImage()
        } catch (error: Exception) {
            if (resources.isLive()) {
                resources.failed(error)
                listener.onFailure(LynxSubErrorCode.E_RESOURCE_IMAGE_EXCEPTION, error)
            }
            return
        }
        val managed = ManagedRequest(
            resources,
            request,
            listener,
            animationListener,
            context,
            lease,
        )
        val admitted = synchronized(lock) {
            if (contexts[context] !== resources) {
                false
            } else {
                requests[request] = managed
                true
            }
        }
        if (!admitted) {
            lease.close()
            checkIdle()
            return
        }
        try {
            executor.execute(managed::start)
        } catch (error: Exception) {
            managed.failBeforeStart(error)
        }
    }

    override fun releaseImage(request: ImageRequestInfo) {
        val managed = synchronized(lock) { requests[request] }
        if (managed == null) {
            delegate.releaseImage(request)
        } else {
            managed.release()
        }
    }

    override fun canParseUrl(url: String): Boolean =
        url.startsWith("hot-updater:///") || delegate.canParseUrl(url)

    override fun createBackgroundImageDrawable(
        context: Context,
        url: String,
    ): BackgroundLayerDrawable? {
        val extension = delegate as? ILynxImageServiceExtension ?: return null
        val resources = synchronized(lock) { contexts[context] }
        if (resources == null || !resources.owns(url)) {
            return extension.createBackgroundImageDrawable(context, url)
        }
        val lease = try {
            resources.beginImage()
        } catch (error: Exception) {
            if (resources.isLive()) resources.failed(error)
            return null
        }
        return try {
            val translated = lease.prepare(url)
            val drawable = extension.createBackgroundImageDrawable(context, translated)
            if (drawable == null) {
                lease.close()
                null
            } else {
                ManagedBackgroundDrawable(drawable, lease)
            }
        } catch (error: Exception) {
            lease.close()
            if (resources.isLive()) resources.failed(error)
            null
        }
    }

    override fun onLynxEnvSetup() {
        (delegate as? ILynxImageServiceExtension)?.onLynxEnvSetup()
    }

    internal fun activeRequestCount(): Int = synchronized(lock) {
        requests.values.toIdentitySet().size
    }

    private fun cancel(resources: LynxReleaseResources) {
        val managed = synchronized(lock) {
            requests.values.toIdentitySet().filter { it.resources === resources }
        }
        managed.forEach(ManagedRequest::release)
    }

    private fun remove(managed: ManagedRequest) {
        synchronized(lock) {
            requests.entries.removeAll { it.value === managed }
        }
    }

    private fun checkIdle() {
        val idle = synchronized(lock) {
            if (!idleNotified &&
                owners == 0 && contexts.isEmpty() && requests.isEmpty()
            ) {
                idleNotified = true
                true
            } else {
                false
            }
        }
        if (idle) onIdle(this)
    }

    private inner class ManagedRequest(
        val resources: LynxReleaseResources,
        private val original: ImageRequestInfo,
        private val listener: ImageLoadListener,
        private val animationListener: AnimationListener?,
        private val context: Context,
        private val lease: LynxReleaseResources.ManagedImageLease,
    ) {
        private var translated: ImageRequestInfo? = null
        private var preparing = false
        private var started = false
        private var terminalClaimed = false
        private var finished = false
        private var cancelled = false
        private var delegateReleased = false

        fun start() {
            synchronized(lock) {
                if (cancelled) return
                preparing = true
            }
            val translatedUrl = try {
                lease.prepare(original.url)
            } catch (error: Exception) {
                failBeforeStart(error)
                return
            }
            val translatedRequest = original.copyWithUrl(translatedUrl)
            var abandoned = false
            synchronized(lock) {
                preparing = false
                if (cancelled) {
                    remove(this)
                    abandoned = true
                } else {
                    translated = translatedRequest
                    requests[translatedRequest] = this
                    started = true
                    try {
                        delegate.fetchImage(
                            translatedRequest,
                            Callback(),
                            animationListener,
                            context,
                        )
                    } catch (error: Exception) {
                        finishFailure(
                            LynxSubErrorCode.E_RESOURCE_IMAGE_EXCEPTION,
                            error,
                        )
                    }
                }
            }
            if (abandoned) {
                lease.close()
                checkIdle()
            }
        }

        fun failBeforeStart(error: Exception) {
            val shouldReport = synchronized(lock) {
                if (terminalClaimed || cancelled) {
                    false
                } else {
                    terminalClaimed = true
                    finished = true
                    true
                }
            }
            try {
                if (shouldReport) {
                    lease.accept {
                        resources.failed(error)
                        listener.onFailure(
                            LynxSubErrorCode.E_RESOURCE_IMAGE_EXCEPTION,
                            error,
                        )
                    }
                }
            } finally {
                lease.close()
                checkIdle()
            }
        }

        fun release() {
            var release: ImageRequestInfo? = null
            var close = false
            synchronized(lock) {
                if (cancelled) return
                cancelled = true
                when {
                    !started -> {
                        finished = true
                        close = !preparing
                    }
                    !delegateReleased -> {
                        delegateReleased = true
                        release = checkNotNull(translated)
                        close = finished
                    }
                }
                remove(this)
            }
            release?.let(delegate::releaseImage)
            if (close) lease.close()
            checkIdle()
        }

        private fun finishSuccess(
            image: ImageContent?,
            info: ImageInfo,
        ) {
            val claimed = synchronized(lock) {
                if (terminalClaimed) false else {
                    terminalClaimed = true
                    true
                }
            }
            if (!claimed) {
                image?.releaseImageResource()
                return
            }
            try {
                completionExecutor.execute {
                    completeSuccessOnMain(image, info)
                }
            } catch (error: Exception) {
                finishCompletionDispatchFailure(image, error)
            }
        }

        private fun completeSuccessOnMain(
            image: ImageContent?,
            info: ImageInfo,
        ) {
            val deliver = synchronized(lock) {
                finished = true
                !cancelled
            }
            try {
                if (!deliver || !lease.completeSuccess {
                        listener.onSuccess(image, original, info)
                    }
                ) {
                    image?.releaseImageResource()
                }
            } catch (error: Exception) {
                image?.releaseImageResource()
                runCatching { resources.failed(error) }
            } finally {
                lease.close()
                checkIdle()
            }
        }

        private fun finishCompletionDispatchFailure(
            image: ImageContent?,
            error: Exception,
        ) {
            val deliver = synchronized(lock) {
                finished = true
                !cancelled
            }
            image?.releaseImageResource()
            try {
                if (deliver) {
                    lease.accept {
                        resources.failed(error)
                        listener.onFailure(
                            LynxSubErrorCode.E_RESOURCE_IMAGE_EXCEPTION,
                            error,
                        )
                    }
                }
            } finally {
                lease.close()
                checkIdle()
            }
        }

        private fun finishFailure(code: Int, error: Throwable) {
            val deliver = synchronized(lock) {
                if (terminalClaimed) return
                terminalClaimed = true
                finished = true
                !cancelled
            }
            try {
                if (deliver) {
                    val exception = error as? Exception ?: RuntimeException(error)
                    lease.accept {
                        resources.failed(exception)
                        listener.onFailure(code, error)
                    }
                }
            } finally {
                lease.close()
                checkIdle()
            }
        }

        private inner class Callback : ImageLoadListener {
            override fun onRequestSubmit(request: ImageRequestInfo) {
                if (!synchronized(lock) { cancelled || terminalClaimed }) {
                    lease.accept { listener.onRequestSubmit(original) }
                }
            }

            override fun onSuccess(
                image: ImageContent?,
                request: ImageRequestInfo,
                info: ImageInfo,
            ) = finishSuccess(image, info)

            override fun onFailure(code: Int, error: Throwable) =
                finishFailure(code, error)

            override fun onImageMonitorInfo(info: org.json.JSONObject) {
                if (!synchronized(lock) { cancelled || terminalClaimed }) {
                    lease.accept { listener.onImageMonitorInfo(info) }
                }
            }
        }
    }

    private fun <T> Collection<T>.toIdentitySet(): Set<T> =
        java.util.Collections.newSetFromMap(IdentityHashMap<T, Boolean>()).also {
            it.addAll(this)
        }
}

internal object ManagedLynxImageServices {
    private val lock = Any()

    fun acquire(resources: LynxReleaseResources): Registration = synchronized(lock) {
        val center = LynxServiceCenter.inst()
        val current = checkNotNull(center.getService(ILynxImageService::class.java)) {
            "Lynx image service must be initialized before constructing a Lynx view"
        }
        val service = if (current is ManagedLynxImageService) {
            current
        } else {
            ManagedLynxImageService(current).also {
                center.registerService(it)
            }
        }
        service.retainOwner()
        Registration(service, resources)
    }

    internal class Registration(
        private val service: ManagedLynxImageService,
        private val resources: LynxReleaseResources,
    ) : AutoCloseable {
        private val closed = AtomicBoolean()
        private var context: Context? = null

        fun bind(context: Context) {
            check(!closed.get() && this.context == null)
            service.register(context, resources)
            this.context = context
        }

        fun unbind() {
            context?.let { service.unregister(it, resources) }
            context = null
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            unbind()
            service.releaseOwner(resources)
        }
    }
}

private object MainThreadExecutor : Executor {
    override fun execute(command: Runnable) {
        val mainLooper = Looper.getMainLooper()
        if (Looper.myLooper() === mainLooper) {
            command.run()
            return
        }
        check(Handler(mainLooper).post(command)) {
            "Cannot dispatch Lynx image completion to the main thread"
        }
    }
}

private class ManagedBackgroundDrawable(
    private val delegate: BackgroundLayerDrawable,
    private val lease: AutoCloseable,
) : BackgroundLayerDrawable(), Drawable.Callback {
    private val detached = AtomicBoolean()

    init {
        delegate.callback = this
    }

    override fun draw(canvas: Canvas) = delegate.draw(canvas)
    override fun onBoundsChange(bounds: Rect) {
        delegate.bounds = bounds
    }

    override fun onStateChange(state: IntArray): Boolean = delegate.setState(state)
    override fun isStateful(): Boolean = delegate.isStateful
    override fun onLevelChange(level: Int): Boolean = delegate.setLevel(level)
    override fun setVisible(visible: Boolean, restart: Boolean): Boolean =
        super.setVisible(visible, restart) or delegate.setVisible(visible, restart)

    override fun onLayoutDirectionChanged(layoutDirection: Int): Boolean =
        delegate.setLayoutDirection(layoutDirection)

    override fun jumpToCurrentState() = delegate.jumpToCurrentState()
    override fun getIntrinsicWidth(): Int = delegate.intrinsicWidth
    override fun getIntrinsicHeight(): Int = delegate.intrinsicHeight
    override fun getMinimumWidth(): Int = delegate.minimumWidth
    override fun getMinimumHeight(): Int = delegate.minimumHeight
    override fun getPadding(padding: Rect): Boolean = delegate.getPadding(padding)
    override fun isReady(): Boolean = delegate.isReady
    override fun getImageWidth(): Int = delegate.imageWidth
    override fun getImageHeight(): Int = delegate.imageHeight
    override fun onAttach() = delegate.onAttach()
    override fun onSizeChanged(width: Int, height: Int) =
        delegate.onSizeChanged(width, height)

    override fun onDetach() {
        try {
            delegate.onDetach()
        } finally {
            if (detached.compareAndSet(false, true)) lease.close()
        }
    }

    override fun setAlpha(alpha: Int) = delegate.setAlpha(alpha)
    override fun setColorFilter(colorFilter: ColorFilter?) =
        delegate.setColorFilter(colorFilter)

    @Suppress("DEPRECATION")
    override fun getOpacity(): Int = delegate.opacity
    override fun setPathEffect(path: Path?) = delegate.setPathEffect(path)
    override fun getPathEffect(): Path? = delegate.pathEffect
    override fun setBitmapConfig(config: Bitmap.Config?) = delegate.setBitmapConfig(config)
    override fun setEnableBitmapGradient(enable: Boolean) =
        delegate.setEnableBitmapGradient(enable)

    override fun setLynxUI(lynxUI: LynxBaseUI?) = delegate.setLynxUI(lynxUI)
    override fun onLynxUIPropsUpdated() = delegate.onLynxUIPropsUpdated()

    override fun invalidateDrawable(who: Drawable) = invalidateSelf()
    override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) =
        scheduleSelf(what, `when`)

    override fun unscheduleDrawable(who: Drawable, what: Runnable) =
        unscheduleSelf(what)
}

private fun ImageRequestInfo.copyWithUrl(url: String): ImageRequestInfo {
    val builder = ImageRequestInfoBuilder.newBuilderWithSource(url)
        .setResizeWidth(resizeWidth)
        .setResizeHeight(resizeHeight)
        .setLoopCount(loopCount)
        .setBitmapConfig(config)
        .setEnableGifLiteDecoder(isEnableGifLiteDecoder)
        .setCacheChoice(cacheChoice)
        .setBitmapPostProcessor(processors)
        .setEnableResourceHint(isEnableResourceHint)
        .setEnableDownSampling(isEnableDownSampling)
        .setUseLocalCache(isUseLocalCache)
        .setCallerContext(callerContext)
        .setEnableAsyncRequest(isEnableAsyncRequest)
        .setEnableAnimationAutoPlay(isAutoPlay)
        .setForceStaticImage(isForceStaticImage)
        .setEnablePremultiplied(isEnablePremultiplied)
        .setSmoothAnimation(isEnableSmoothAnimation)
        .setProgressiveRendering(isEnableProgressiveRendering)
        .setEnableReportInfo(isEnableReportInfo)
        .setCacheKeyPathOnly(isCacheKeyPathOnly)
        .setImageSRScale(imageSRScale)
        .setRegionToDecode(regionToDecode)
    builder.setCustomParam(customParam)
    builder.setDiskCacheChoice(diskCacheChoice)
    return builder.build()
}
