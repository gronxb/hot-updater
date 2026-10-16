package com.hotupdater

import org.junit.rules.ExternalResource
import java.lang.reflect.Field

/**
 * Leaves no crash monitoring behind. A launch that a test prepares installs
 * the recovery manager's process-wide uncaught exception handler, which ends
 * the process, and keeps its monitored launch in process-wide state. Tests
 * share one JVM, so after each test this restores the JVM's handler and stops
 * every launch the test left monitored, as its grace period would on a device.
 */
class RecoveryMonitoringRule : ExternalResource() {
    private var previousHandler: Thread.UncaughtExceptionHandler? = null

    public override fun before() {
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        // A claim's release would run on a real timer, during a later test;
        // a test that needs one runs it by hand (HotUpdaterRecoveryManager.releaseClaim).
        HotUpdaterRecoveryManager.claimReleaseScheduler = { _, _ -> }
    }

    public override fun after() {
        Thread.setDefaultUncaughtExceptionHandler(previousHandler)
        val manager = HotUpdaterRecoveryManager::class.java
        // The next test that monitors a launch installs the handler again,
        // over the JVM's own, and this rule removes it again.
        field(manager, "exceptionHandlerInstalled").setBoolean(null, false)
        field(manager, "previousExceptionHandler").set(null, null)

        @Suppress("UNCHECKED_CAST")
        val liveManagers = field(manager, "liveManagers").get(null) as MutableMap<String, Any>
        liveManagers.values.toList().forEach { live ->
            val generation = field(live.javaClass, "generation").getLong(live)
            live.javaClass
                .getDeclaredMethod("stopMonitoring", Long::class.javaPrimitiveType)
                .apply { isAccessible = true }
                .invoke(live, generation)
        }
        liveManagers.clear()

        // Activities a test handed over must not show another test's gate a view.
        val attribution = HotUpdaterRecoveryAttribution.shared
        listOf("activities", "startedActivities").forEach { name ->
            val activities = field(attribution.javaClass, name).get(attribution) as MutableSet<*>
            synchronized(field(attribution.javaClass, "activities").get(attribution)!!) { activities.clear() }
        }
        (field(attribution.javaClass, "runtimes").get(attribution) as MutableList<*>).clear()

        // Content a test held must not verify another test's launch.
        val heldContent = field(manager, "heldContent").get(null)
        synchronized(heldContent) { (field(heldContent.javaClass, "held").get(heldContent) as MutableList<*>).clear() }

        HotUpdaterRecoveryManager.claimReleaseScheduler = { _, _ -> }
        HotUpdaterRecoveryManager.rootTagOwner = HotUpdaterRecoveryManager.defaultRootTagOwner
        HotUpdaterRecoveryManager.nativeRecovery = HotUpdaterNativeRecovery.jni
        synchronized(HotUpdaterRecoveryManager.recoveryLock) {
            (field(manager, "claimedOwners").get(null) as MutableSet<*>).clear()
            (field(manager, "disarmedByClaim").get(null) as MutableMap<*, *>).clear()
            (field(manager, "relaunchIntents").get(null) as MutableSet<*>).clear()
            (field(manager, "activeClaims").get(null) as MutableMap<*, *>).clear()
            (field(manager, "claimErrors").get(null) as MutableMap<*, *>).clear()
            (field(manager, "claimHolders").get(null) as MutableMap<*, *>).clear()
        }

        // A JavaScript error a test claimed must not claim another test's crash.
        val slots = field(manager, "slots").get(null)
        field(slots.javaClass, "attributedName").set(slots, null)
    }

    private fun field(
        owner: Class<*>,
        name: String,
    ): Field = owner.getDeclaredField(name).apply { isAccessible = true }
}
