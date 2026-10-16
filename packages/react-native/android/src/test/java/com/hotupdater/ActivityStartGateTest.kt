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
    fun `a gate that knows the activities started before it waits for its view there`() {
        // A named instance prepared while the app already shows a native
        // screen: the started activity is not its view.
        val application = RecordingApplication()
        var runs = 0
        showsReactView = false
        val gate = createGate(application, startedBefore = true, activitiesStartedBefore = { listOf(activity) })

        gate.runWhenActivityStarted { runs += 1 }
        assertEquals(0, runs)
        assertEquals(1, layoutWatches)

        showsReactView = true
        application.layout()
        assertEquals(1, runs)
        assertEquals(0, layoutWatches)
    }

    @Test
    fun `a gate that knows the activities started before it runs at once when one shows its view`() {
        val application = RecordingApplication()
        var runs = 0

        createGate(application, startedBefore = true, activitiesStartedBefore = { listOf(activity) })
            .runWhenActivityStarted { runs += 1 }

        assertEquals(1, runs)
    }

    @Test
    fun `a gate that knows no activity started before it waits for the next start`() {
        val application = RecordingApplication()
        var runs = 0
        val gate = createGate(application, startedBefore = true, activitiesStartedBefore = { emptyList() })

        gate.runWhenActivityStarted { runs += 1 }
        assertEquals(0, runs)

        application.startActivity()
        assertEquals(1, runs)
    }

    @Test
    fun `runs at once without an application to observe`() {
        var runs = 0

        createGate(null).runWhenActivityStarted { runs += 1 }

        assertEquals(1, runs)
    }

    @Test
    fun `native screen without a React Native view waits for one`() {
        // A brownfield app loads the bundle with its first native screen.
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0
        showsReactView = false

        application.startActivity()
        gate.runWhenActivityStarted { runs += 1 }
        assertEquals(0, runs)
        application.layout()
        assertEquals(0, runs)

        showsReactView = true
        application.layout()
        application.layout()
        assertEquals(1, runs)
        assertEquals(0, layoutWatches)
    }

    @Test
    fun `native screen that never shows React Native never runs`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0
        showsReactView = false

        gate.runWhenActivityStarted { runs += 1 }
        application.startActivity()
        application.layout()
        application.stopActivity()
        showsReactView = true
        application.layout()

        assertEquals(0, runs)
        assertEquals(0, layoutWatches)
    }

    @Test
    fun `activity that starts with a React Native view runs at once`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        var runs = 0
        showsReactView = false

        gate.runWhenActivityStarted { runs += 1 }
        application.startActivity()
        assertEquals(0, runs)
        application.stopActivity()

        showsReactView = true
        application.startActivity()
        assertEquals(1, runs)
        assertEquals(0, layoutWatches)
    }

    @Test
    fun `next launch stops watching for the waiting one`() {
        val application = RecordingApplication()
        val gate = createGate(application)
        val runs = mutableListOf<String>()
        showsReactView = false

        application.startActivity()
        gate.runWhenActivityStarted { runs += "first" }
        gate.runWhenActivityStarted(null)
        assertEquals(0, layoutWatches)

        showsReactView = true
        application.layout()
        assertEquals(emptyList<String>(), runs)
    }

    private var showsReactView = true
    private val layoutListeners = mutableListOf<() -> Unit>()
    private val layoutWatches get() = layoutListeners.size

    private fun createGate(
        application: Application?,
        startedBefore: Boolean = false,
        activitiesStartedBefore: (() -> Collection<Activity>)? = null,
    ) = ActivityStartGate(
        application,
        processHasStartedActivity = { startedBefore },
        showsReactView = { showsReactView },
        watchLayout = { _, onLayout ->
            layoutListeners += onLayout
            { layoutListeners -= onLayout }
        },
        activitiesStartedBefore = activitiesStartedBefore,
    )

    private inner class RecordingApplication : Application() {
        private val callbacks = mutableListOf<ActivityLifecycleCallbacks>()

        override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
            callbacks += callback
        }

        fun startActivity() = callbacks.forEach { it.onActivityStarted(activity) }

        fun stopActivity() = callbacks.forEach { it.onActivityStopped(activity) }

        fun layout() = layoutListeners.toList().forEach { it() }
    }
}
