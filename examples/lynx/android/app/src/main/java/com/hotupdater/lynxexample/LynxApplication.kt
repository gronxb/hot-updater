package com.hotupdater.lynxexample

import android.app.Application
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.core.MemoryChunkType
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingModules
import com.tiktok.sparkling.hybridkit.HybridKit
import com.tiktok.sparkling.hybridkit.config.BaseInfoConfig
import com.tiktok.sparkling.hybridkit.config.SparklingHybridConfig
import com.tiktok.sparkling.hybridkit.config.SparklingLynxConfig

class LynxApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Fresco.initialize(
            this,
            ImagePipelineConfig.newBuilder(this)
                .setMemoryChunkType(MemoryChunkType.BUFFER_MEMORY)
                .build(),
        )
        HybridKit.init(this)
        val lynx = SparklingLynxConfig.build(this) {
            addLynxModules(HotUpdaterSparklingModules.modules())
        }
        HybridKit.setHybridConfig(
            SparklingHybridConfig.build(BaseInfoConfig(isDebug = false)) {
                setLynxConfig(lynx)
            },
            this,
        )
        HybridKit.initLynxKit()
    }
}
