package com.hotupdater.lynx.sparkling

import android.os.Bundle
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity

/** Packaged full-page Activity used for every managed secondary route. */
internal interface ManagedSparklingPageAuthority {
    fun attachPage(
        pageId: String,
        activity: HotUpdaterSparklingPageActivity,
    ): View?

    fun requestBack(activity: android.app.Activity): Boolean

    fun activityDetached(activity: android.app.Activity)

    fun pageAttachFailed(
        pageId: String,
        activity: HotUpdaterSparklingPageActivity,
        error: Throwable,
    )
}

class HotUpdaterSparklingPageActivity : ComponentActivity() {
    private var host: ManagedSparklingPageAuthority? = null
    private var closing = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (host?.requestBack(this@HotUpdaterSparklingPageActivity) == true) {
                        closing = true
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
        val incomingHost = intent.getStringExtra(EXTRA_HOST_ID)
        val incomingPage = intent.getStringExtra(EXTRA_PAGE_ID)
        if (incomingHost == null || incomingPage == null) {
            finish()
            return
        }
        bind(incomingHost)
        val view = try {
            host?.attachPage(incomingPage, this)
        } catch (error: Throwable) {
            runCatching { host?.pageAttachFailed(incomingPage, this, error) }
            finish()
            return
        }
        if (view == null) {
            finish()
            return
        }
        setContentView(view)
    }

    internal fun bind(hostId: String) {
        host = ManagedSparklingHostRegistry.pageAuthority(hostId)
    }

    override fun finish() {
        closing = true
        super.finish()
    }

    override fun onDestroy() {
        if (!closing) host?.activityDetached(this)
        host = null
        super.onDestroy()
    }

    companion object {
        internal const val EXTRA_HOST_ID =
            "com.hotupdater.lynx.sparkling.HOST_ID"
        internal const val EXTRA_PAGE_ID =
            "com.hotupdater.lynx.sparkling.PAGE_ID"
        internal const val EXTRA_ANIMATED =
            "com.hotupdater.lynx.sparkling.ANIMATED"
    }
}
