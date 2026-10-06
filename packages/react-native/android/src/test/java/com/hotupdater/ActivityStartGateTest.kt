package com.hotupdater

import android.app.Activity
import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Test

class ActivityStartGateTest {
    private val activity = Activity()

    @Test
    fun `headless launch waits for the first activity start`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0

        gate.runWhenActivityStarted { runs += 1 }
        assertEquals(0, runs)

        application.startActivity()
        application.startActivity()
        assertEquals(1, runs)
    }

    @Test
    fun `launch with a started activity runs at once`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0

        application.startActivity()
        gate.runWhenActivityStarted { runs += 1 }
        assertEquals(1, runs)
    }

    @Test
    fun `stopped activity waits for the next start`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0

        application.startActivity()
        application.stopActivity()
        gate.runWhenActivityStarted { runs += 1 }
        assertEquals(0, runs)

        application.startActivity()
        assertEquals(1, runs)
    }

    @Test
    fun `stop of an activity started before the gate keeps later starts counted`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0

        application.stopActivity()
        application.startActivity()
        gate.runWhenActivityStarted { runs += 1 }

        assertEquals(1, runs)
    }

    @Test
    fun `next launch replaces or cancels the waiting one`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        val runs = mutableListOf<String>()

        gate.runWhenActivityStarted { runs += "first" }
        gate.runWhenActivityStarted { runs += "reload" }
        application.startActivity()
        application.stopActivity()
        gate.runWhenActivityStarted { runs += "verified" }
        gate.runWhenActivityStarted(null)
        application.startActivity()

        assertEquals(listOf("reload"), runs)
    }

    @Test
    fun `activity started before the gate runs at once`() {
        // A brownfield app adds React Native to an activity already on screen,
        // and Android does not replay that start to a late registration.
        val application = RecordingApplication()
        var runs = 0

        createGate(application, startedBefore = true).runWhenActivityStarted { runs += 1 }

        assertEquals(1, runs)
    }

    @Test
    fun `runs at once without an application to observe`() {
        var runs = 0

        createGate(null).runWhenActivityStarted { runs += 1 }

        assertEquals(1, runs)
    }

    private fun createGate(
        application: Application?,
        startedBefore: Boolean = false,
    ) = ActivityStartGate(application) { startedBefore }

    private inner class RecordingApplication : Application() {
        private val callbacks = mutableListOf<ActivityLifecycleCallbacks>()

        override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
            callbacks += callback
        }

        fun startActivity() = callbacks.forEach { it.onActivityStarted(activity) }

        fun stopActivity() = callbacks.forEach { it.onActivityStopped(activity) }
    }
}
