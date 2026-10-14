package com.hotupdater

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import com.facebook.react.ReactRootView

/**
 * An in-process reload restarts each surface in its existing view, and a view
 * logs CONTENT_APPEARED only for its first content. Asks every React root view
 * of the activity to log it again, so the reloaded bundle's first content
 * completes its launch, as a cold start does. Otherwise the next process rolls
 * the working bundle back as an unfinished launch.
 */
internal object ContentAppearedLog {
    fun rearm(activity: Activity?) {
        activity?.window?.decorView?.let(::rearm)
    }

    private fun rearm(view: View) {
        if (view is ReactRootView) {
            view.setShouldLogContentAppeared(true)
        }
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                rearm(view.getChildAt(index))
            }
        }
    }
}
