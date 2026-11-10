package com.hotupdater

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log
import kotlin.math.sqrt

private const val TAG = "HotUpdaterSandbox"
private const val SHAKE_FORCE = 2.7f
private const val SPIKE_MIN_MS = 50L
private const val SPIKE_MAX_MS = 700L
private const val OPEN_COOLDOWN_MS = 2_000L

/** Opens the screen over the app on a shake, while one of the app's activities is resumed. */
internal class HotUpdaterSandboxShake(
    context: Context,
) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private var resumed: Activity? = null
    private var lastSpike = 0L
    private var lastOpen = 0L

    fun watch(activity: Activity) {
        resumed = activity
        val sensors = sensors ?: return
        val accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        sensors.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI)
    }

    fun stop(activity: Activity) {
        if (activity !== resumed) return
        resumed = null
        sensors?.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val (x, y, z) = event.values
        if (sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH < SHAKE_FORCE) return
        val now = SystemClock.uptimeMillis()
        val isShake = now - lastSpike in SPIKE_MIN_MS..SPIKE_MAX_MS
        lastSpike = now
        if (!isShake || now - lastOpen < OPEN_COOLDOWN_MS) return
        lastOpen = now
        val activity = resumed ?: return
        Log.i(TAG, "shake")
        activity.startActivity(
            Intent(activity, HotUpdaterSandboxActivity::class.java)
                .putExtra(HotUpdaterSandboxActivity.EXTRA_OVER_APP, true),
        )
    }

    override fun onAccuracyChanged(
        sensor: Sensor?,
        accuracy: Int,
    ) = Unit
}
