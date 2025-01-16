package com.hotupdater

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class HotUpdaterPackage : BaseReactPackage() {
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
}
