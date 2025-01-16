package com.hotupdater.source.file

import android.content.Context

interface FileDataSource {
    fun convertFileSystemPath(
        context: Context,
        basePath: String,
    ): String

    fun stripPrefix(
        prefix: String,
        path: String,
    ): String

    fun extractZipFileAtPath(
        zipFilePath: String,
        destinationPath: String,
    ): Boolean
}
