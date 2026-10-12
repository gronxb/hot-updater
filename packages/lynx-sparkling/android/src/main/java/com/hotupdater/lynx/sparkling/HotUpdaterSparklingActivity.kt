package com.hotupdater.lynx.sparkling

import android.app.Activity
import android.os.Bundle

/** Mounts the primary page and owns its host across Activity recreation. */
abstract class HotUpdaterSparklingActivity : Activity() {
    private var hotUpdaterHost: HotUpdaterSparklingHost? = null

    protected abstract fun createHotUpdaterConfiguration(): HotUpdaterSparklingConfiguration

    final override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        (lastNonConfigurationInstance as? HotUpdaterSparklingHost)?.let { host ->
            hotUpdaterHost = host
            setContentView(host.reattachPrimary(this))
            return
        }
        val host = HotUpdaterSparklingHost(
            applicationContext,
            createHotUpdaterConfiguration(),
        )
        hotUpdaterHost = host
        setContentView(host.createView(this))
    }

    final override fun onDestroy() {
        if (isChangingConfigurations) {
            hotUpdaterHost?.primaryActivityDetachedForRecreation(this)
        } else {
            hotUpdaterHost?.close()
        }
        hotUpdaterHost = null
        super.onDestroy()
    }

    final override fun onRetainNonConfigurationInstance(): Any? = hotUpdaterHost
}
