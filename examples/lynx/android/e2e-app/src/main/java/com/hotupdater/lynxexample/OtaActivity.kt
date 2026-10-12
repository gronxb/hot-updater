package com.hotupdater.lynxexample

import com.hotupdater.lynx.LynxHostConfigurationProvider
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingActivity
import com.hotupdater.lynx.sparkling.HotUpdaterSparklingConfiguration

/** Foreground and OS background entry points use the same native scope. */
class OtaActivity : HotUpdaterSparklingActivity() {
    override fun createHotUpdaterConfiguration() = HotUpdaterSparklingConfiguration(
            lynx = (application as LynxHostConfigurationProvider).createLynxHostConfiguration(),
            allowDiagnosticIntentLaunchConfiguration = true,
    )
}
