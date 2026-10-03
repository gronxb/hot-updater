package com.hotupdater

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Build

internal object NetworkState {
    /**
     * True when the device reports no active network. False when it has one,
     * or when that cannot be told, as when the app lacks
     * `ACCESS_NETWORK_STATE`.
     */
    fun hasNoActiveNetwork(context: Context): Boolean =
        try {
            val permission = context.checkCallingOrSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE)
            val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            when {
                permission != PackageManager.PERMISSION_GRANTED || connectivity == null -> false
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> connectivity.activeNetwork == null
                else -> hasNoConnectedNetworkLegacy(connectivity)
            }
        } catch (_: Exception) {
            false
        }

    @Suppress("DEPRECATION")
    private fun hasNoConnectedNetworkLegacy(connectivity: ConnectivityManager): Boolean =
        connectivity.activeNetworkInfo?.isConnected != true
}
