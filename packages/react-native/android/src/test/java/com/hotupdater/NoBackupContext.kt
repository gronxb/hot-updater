package com.hotupdater

import android.content.ContextWrapper
import java.io.File

/** A context whose `noBackupFilesDir` is a test directory. */
internal class NoBackupContext(
    private val noBackupDirectory: File,
) : ContextWrapper(null) {
    override fun getNoBackupFilesDir(): File = noBackupDirectory
}
