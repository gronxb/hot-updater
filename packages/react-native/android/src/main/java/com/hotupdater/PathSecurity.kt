package com.hotupdater

import java.io.File

internal object PathSecurity {
    fun normalizeRelativePath(path: String): String? {
        if (path.isBlank() || path.indexOf('\u0000') >= 0 || path.contains('\\')) {
            return null
        }

        if (File(path).isAbsolute || Regex("^[A-Za-z]:").containsMatchIn(path)) {
            return null
        }

        val components = path.split("/")
        if (components.any { it.isEmpty() || it == "." || it == ".." }) {
            return null
        }

        return components.joinToString("/")
    }

    fun resolveInside(
        root: File,
        relativePath: String,
    ): File? {
        val normalizedPath = normalizeRelativePath(relativePath) ?: return null
        val file = File(root, normalizedPath)
        return if (isInside(root, file)) file else null
    }

    fun isInside(
        root: File,
        file: File,
    ): Boolean {
        val rootPath = root.canonicalFile.path
        val filePath = file.canonicalFile.path
        return filePath == rootPath ||
            filePath.startsWith("$rootPath${File.separator}")
    }
}
