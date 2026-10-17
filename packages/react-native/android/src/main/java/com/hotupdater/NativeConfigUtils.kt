package com.hotupdater

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

object NativeConfigUtils {
    const val CHANNEL_META_DATA_KEY = "com.hotupdater.CHANNEL"
    const val FINGERPRINT_HASH_META_DATA_KEY = "com.hotupdater.FINGERPRINT_HASH"
    const val PUBLIC_KEY_META_DATA_KEY = "com.hotupdater.PUBLIC_KEY"

    fun getString(
        context: Context,
        metaDataKey: String,
    ): String? {
        // Main's options and the deprecated HotUpdater.configure take
        // priority over manifest metadata (see HotUpdaterConfig).
        val override =
            when (metaDataKey) {
                FINGERPRINT_HASH_META_DATA_KEY -> HotUpdaterConfig.fingerprintHash
                PUBLIC_KEY_META_DATA_KEY -> HotUpdaterConfig.publicKey
                CHANNEL_META_DATA_KEY -> HotUpdaterConfig.channel
                else -> null
            }
        override?.takeIf { it.isNotEmpty() }?.let { return it }

        return getManifestString(context, metaDataKey)
    }

    /** The merged manifest's value alone, which named instances read. */
    internal fun getManifestString(
        context: Context,
        key: String,
    ): String? =
        try {
            val packageManager = context.packageManager
            val applicationInfo =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    packageManager.getApplicationInfo(
                        context.packageName,
                        PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
                    )
                } else {
                    @Suppress("DEPRECATION")
                    packageManager.getApplicationInfo(
                        context.packageName,
                        PackageManager.GET_META_DATA,
                    )
                }

            @Suppress("DEPRECATION")
            coerceManifestMetaDataString(applicationInfo.metaData?.get(key))
        } catch (e: Exception) {
            null
        }

    internal fun coerceManifestMetaDataString(value: Any?): String? =
        value
            ?.toString()
            ?.takeIf { it.isNotEmpty() }
}
