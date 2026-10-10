package com.hotupdater.lynxmatrix

import android.app.Application
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.imagepipeline.core.ImagePipelineConfig
import com.facebook.imagepipeline.memory.PoolConfig
import com.facebook.imagepipeline.memory.PoolFactory
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingModules
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingDiagnostics
import com.tiktok.sparkling.hybridkit.HybridKit
import com.tiktok.sparkling.hybridkit.config.BaseInfoConfig
import com.tiktok.sparkling.hybridkit.config.SparklingHybridConfig
import com.tiktok.sparkling.hybridkit.config.SparklingLynxConfig

class MatrixApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        val factory = PoolFactory(PoolConfig.newBuilder().build())
        Fresco.initialize(
            this,
            ImagePipelineConfig.newBuilder(this)
                .setPoolFactory(factory)
                .build(),
        )
        HybridKit.init(this)
        val lynx = SparklingLynxConfig.build(this) {
            addLynxModules(HotUpdaterSparklingModules.modules())
            addLynxModules(HotUpdaterSparklingDiagnostics.modules())
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
