package com.hotupdater

import android.content.Context
import java.io.File

/**
 * SDK state that must never be restored onto another installation lives in
 * `noBackupFilesDir/hot-updater`, which Android Auto Backup skips.
 */
internal object NoBackupStorage {
    private const val DIRECTORY_NAME = "hot-updater"

    fun file(
        context: Context,
        name: String,
    ): File = File(File(context.noBackupFilesDir, DIRECTORY_NAME), name)
}
