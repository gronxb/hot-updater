package com.hotupdater

import android.os.Handler
import android.os.Looper

/**
 * The main thread, where views, lifecycle callbacks, and crash recovery's
 * delayed work run. Tests stand in for it to run posted work by hand.
 */
internal interface HotUpdaterMainThread {
    fun isCurrent(): Boolean

    fun post(task: Runnable)

    fun postDelayed(
        task: Runnable,
        delayMs: Long,
    )

    /** Removes [task] while it waits; one already running is not stopped. */
    fun remove(task: Runnable)

    companion object {
        val android: HotUpdaterMainThread =
            object : HotUpdaterMainThread {
                private val handler by lazy { Handler(Looper.getMainLooper()) }

                override fun isCurrent(): Boolean = Looper.myLooper() == Looper.getMainLooper()

                override fun post(task: Runnable) {
                    handler.post(task)
                }

                override fun postDelayed(
                    task: Runnable,
                    delayMs: Long,
                ) {
                    handler.postDelayed(task, delayMs)
                }

                override fun remove(task: Runnable) {
                    handler.removeCallbacks(task)
                }
            }
    }
}
