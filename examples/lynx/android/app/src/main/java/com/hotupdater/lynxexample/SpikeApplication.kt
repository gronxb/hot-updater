package com.hotupdater.lynxexample

import android.app.Application
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.core.MemoryChunkType
import com.tiktok.sparkling.hybridkit.HybridKit
import com.tiktok.sparkling.hybridkit.config.BaseInfoConfig
import com.tiktok.sparkling.hybridkit.config.SparklingHybridConfig
import com.tiktok.sparkling.hybridkit.config.SparklingLynxConfig
import com.tiktok.sparkling.hybridkit.lynx.SparklingLynxModuleWrapper

class SpikeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // The pinned Fresco native memory library is not 16 KB aligned.
        Fresco.initialize(this, ImagePipelineConfig.newBuilder(this)
            .setMemoryChunkType(MemoryChunkType.BUFFER_MEMORY).build())
        HybridKit.init(this)
        val lynxConfig = SparklingLynxConfig.build(this) {
            setTemplateProvider(ReleaseTemplateProvider())
            addLynxModules(mapOf("HotUpdaterLynxSpike" to SparklingLynxModuleWrapper(SpikeModule::class.java), "HotUpdaterLynx" to SparklingLynxModuleWrapper(com.hotupdater.lynx.HotUpdaterLynxModule::class.java)))
        }
        HybridKit.setHybridConfig(SparklingHybridConfig.build(BaseInfoConfig(isDebug = false)) {
            setLynxConfig(lynxConfig)
        }, this)
        HybridKit.initLynxKit()
    }
}
