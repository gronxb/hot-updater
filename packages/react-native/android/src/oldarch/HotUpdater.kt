package com.hotupdater

import android.content.Context
import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager
import java.io.File

class HotUpdater : ReactPackage {
    override fun createViewManagers(
        context: ReactApplicationContext
    ): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    override fun createNativeModules(
        context: ReactApplicationContext
    ) = listOf(HotUpdaterModule(context = context))

    companion object {
        @JvmStatic
        fun getJSBundleFile(context: Context): String? {
            val sharedPreferences = context.getSharedPreferences(
                "HotUpdaterPrefs",
                Context.MODE_PRIVATE
            )
            val urlString = sharedPreferences.getString(
                "HotUpdaterBundleURL",
                null
            )
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }

            val file = File(urlString)
            if (!file.exists()) {
                sharedPreferences.edit()
                    .putString(
                        "HotUpdaterBundleURL",
                        null
                    )
                    .apply()
                return "assets://index.android.bundle"
            }

            return urlString
        }
    }
}
