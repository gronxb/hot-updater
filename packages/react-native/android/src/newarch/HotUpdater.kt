package com.hotupdater

import android.content.Context
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.io.File

class HotUpdater : BaseReactPackage() {
    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? =
        if (name == HotUpdaterModule.NAME) {
            HotUpdaterModule(context = reactContext)
        } else {
            null
        }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
        ReactModuleInfoProvider {
            val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
            val isTurboModule: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
            moduleInfos[HotUpdaterModule.NAME] =
                ReactModuleInfo(
                    HotUpdaterModule.NAME,
                    HotUpdaterModule.NAME,
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    false,
                    isTurboModule, // isTurboModule
                )
            moduleInfos
        }

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
