package com.hotupdater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class HotUpdaterRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(
        context: Context,
        intent: Intent,
    ) {
        HotUpdaterRecoveryManager.handleRecoveryWatchdog(context)
    }
}
