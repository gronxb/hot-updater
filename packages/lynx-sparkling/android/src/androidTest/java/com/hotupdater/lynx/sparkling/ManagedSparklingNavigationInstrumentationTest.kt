package com.hotupdater.lynx.sparkling

import android.content.ComponentName
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.tiktok.sparkling.method.registry.core.BridgePlatformType
import com.tiktok.sparkling.method.registry.core.SparklingBridgeManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ManagedSparklingNavigationInstrumentationTest {
    @Test
    fun installedBridgeAndActivityExposeThePackagedManagedContract() {
        HotUpdaterSparklingModules.registerNavigation()
        assertEquals(
            ManagedRouterOpenMethod::class.java,
            SparklingBridgeManager.findIDLMethodClass(
                BridgePlatformType.LYNX,
                "router.open",
                SparklingBridgeManager.DEFAULT_NAMESPACE,
            ),
        )
        assertEquals(
            "detail.lynx.bundle",
            ManagedSparklingRoute.parse(
                "hybrid://lynxview_page?bundle=detail.lynx.bundle",
                setOf("detail.lynx.bundle"),
            ).pageEntry,
        )

        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val activity = context.packageManager.getActivityInfo(
            ComponentName(context, HotUpdaterSparklingPageActivity::class.java),
            0,
        )
        assertFalse(activity.exported)
    }
}
