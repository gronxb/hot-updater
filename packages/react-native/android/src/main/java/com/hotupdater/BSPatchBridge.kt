package com.hotupdater

import android.util.Log

internal object BSPatchBridge {
    private const val TAG = "BSPatchBridge"
    private var loadError: String? = null

    init {
        try {
            System.loadLibrary("hotupdater_bspatch")
            Log.d(TAG, "Loaded native bspatch library")
        } catch (e: UnsatisfiedLinkError) {
            loadError = e.message ?: "Unknown load error"
            Log.e(TAG, "Failed to load native bspatch library", e)
        }
    }

    private external fun nativeApplyPatch(
        oldPath: String,
        patchPath: String,
        outputPath: String,
    ): String?

    fun applyPatch(
        oldPath: String,
        patchPath: String,
        outputPath: String,
    ): String? {
        val error = loadError
        if (error != null) {
            return "Native bspatch library unavailable: $error"
        }
        return nativeApplyPatch(oldPath, patchPath, outputPath)
    }
}
