package com.hotupdater

import android.app.Activity
import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext

object HotUpdaterUtils {
    fun getAppVersion(context: Context): String? =
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            packageInfo.versionName
        } catch (e: Exception) {
            null
        }

    fun getCurrentActivity(context: Context): Activity? =
        if (context is ReactApplicationContext) {
            context.currentActivity
        } else {
            null
        }

    // Assuming BuildConfig exists and has BUILD_TIMESTAMP
    // If not, this needs adjustment based on how build time is actually determined
    fun getMinBundleId(): String =
        try {
            val buildTimestampMs = BuildConfig.BUILD_TIMESTAMP
            val bytes =
                ByteArray(16).apply {
                    this[0] = ((buildTimestampMs shr 40) and 0xFF).toByte()
                    this[1] = ((buildTimestampMs shr 32) and 0xFF).toByte()
                    this[2] = ((buildTimestampMs shr 24) and 0xFF).toByte()
                    this[3] = ((buildTimestampMs shr 16) and 0xFF).toByte()
                    this[4] = ((buildTimestampMs shr 8) and 0xFF).toByte()
                    this[5] = (buildTimestampMs and 0xFF).toByte()
                    this[6] = 0x70.toByte() // Placeholder/example values
                    this[7] = 0x00.toByte()
                    this[8] = 0x80.toByte()
                    this[9] = 0x00.toByte()
                    this[10] = 0x00.toByte()
                    this[11] = 0x00.toByte()
                    this[12] = 0x00.toByte()
                    this[13] = 0x00.toByte()
                    this[14] = 0x00.toByte()
                    this[15] = 0x00.toByte()
                }
            String.format(
                "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                bytes[0].toInt() and 0xFF,
                bytes[1].toInt() and 0xFF,
                bytes[2].toInt() and 0xFF,
                bytes[3].toInt() and 0xFF,
                bytes[4].toInt() and 0xFF,
                bytes[5].toInt() and 0xFF,
                bytes[6].toInt() and 0xFF,
                bytes[7].toInt() and 0xFF,
                bytes[8].toInt() and 0xFF,
                bytes[9].toInt() and 0xFF,
                bytes[10].toInt() and 0xFF,
                bytes[11].toInt() and 0xFF,
                bytes[12].toInt() and 0xFF,
                bytes[13].toInt() and 0xFF,
                bytes[14].toInt() and 0xFF,
                bytes[15].toInt() and 0xFF,
            )
        } catch (e: Exception) {
            // Log error or provide a more meaningful default
            "00000000-0000-0000-0000-000000000000"
        }
}
