package com.hotupdater.source.file

import android.content.Context
import android.util.Log
import java.io.File
import java.util.zip.ZipFile

class DefaultFileDataSource : FileDataSource {
    override fun convertFileSystemPath(
        context: Context,
        basePath: String,
    ): String {
        val documentsDir = context.getExternalFilesDir(null)?.absolutePath ?: context.filesDir.absolutePath
        val separator = if (basePath.startsWith("/")) "" else "/"
        return "$documentsDir$separator$basePath"
    }

    override fun stripPrefix(
        prefix: String,
        path: String,
    ) = if (path.startsWith("/$prefix/")) {
        path.replaceFirst(
            "/$prefix/",
            "",
        )
    } else {
        path
    }

    override fun extractZipFileAtPath(
        zipFilePath: String,
        destinationPath: String,
    ): Boolean =
        try {
            ZipFile(zipFilePath).use { zip ->
                zip.entries().asSequence().forEach { entry ->
                    val file =
                        File(
                            destinationPath,
                            entry.name,
                        )
                    if (entry.isDirectory) {
                        file.mkdirs()
                    } else {
                        file.parentFile?.mkdirs()
                        zip.getInputStream(entry).use { input ->
                            file.outputStream().use { output ->
                                input.copyTo(output)
                            }
                        }
                    }
                }
            }
            true
        } catch (e: Exception) {
            Log.e(
                "FileManager",
                "Failed to unzip file",
                e,
            )
            false
        }
}
