package com.hotupdater

import android.content.Context
import android.os.Build
import android.util.TypedValue
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.ZipFile

interface BuiltInAssetResolver {
    fun copyIfMatches(
        assetPath: String,
        expectedHash: String,
        destination: File,
    ): Boolean
}

internal class AndroidBuiltInAssetResolver(
    private val context: Context,
    private val cacheFile: File,
) : BuiltInAssetResolver {
    private data class CachedIndex(
        val packageIdentity: String,
        val locators: MutableMap<String, String>,
    )

    private val lock = Any()

    override fun copyIfMatches(
        assetPath: String,
        expectedHash: String,
        destination: File,
    ): Boolean =
        synchronized(lock) {
            val normalizedPath = RelativePathResolver.normalizeRelativePath(assetPath) ?: return@synchronized false
            val packageIdentity = packageIdentity() ?: return@synchronized false
            val index = readIndex(packageIdentity)
            val cachedLocator = index.locators[normalizedPath]
            if (cachedLocator != null && copyLocatorIfMatches(cachedLocator, expectedHash, destination)) {
                return@synchronized true
            }

            val locator = resolveLocator(normalizedPath) ?: return@synchronized false
            if (!copyLocatorIfMatches(locator, expectedHash, destination)) return@synchronized false

            index.locators[normalizedPath] = locator
            writeIndex(index)
            true
        }

    private fun resolveLocator(assetPath: String): String? {
        if (assetPath == "index.android.bundle") {
            return try {
                context.assets.open(assetPath).close()
                "asset:$assetPath"
            } catch (_: Exception) {
                null
            }
        }

        val firstSlash = assetPath.indexOf('/')
        if (firstSlash <= 0 || firstSlash == assetPath.lastIndex) return null
        val directory = assetPath.substring(0, firstSlash)
        val filename = assetPath.substring(firstSlash + 1)
        val resourceType = directory.substringBefore('-')
        if (resourceType != "drawable" && resourceType != "raw") return null
        val resourceName = filename.substringBeforeLast('.')
        if (resourceName.isEmpty() || resourceName.any { !(it == '_' || it.isLowerCase() || it.isDigit()) }) {
            return null
        }

        return try {
            val resourceId = context.resources.getIdentifier(resourceName, resourceType, context.packageName)
            if (resourceId == 0) return null
            val value = TypedValue()
            val density = densityFor(directory)
            if (density == null) {
                context.resources.getValue(resourceId, value, true)
            } else {
                context.resources.getValueForDensity(resourceId, density, value, true)
            }
            val entry = value.string?.toString() ?: return null
            installedApks().firstNotNullOfOrNull { apk ->
                try {
                    ZipFile(apk).use { zip ->
                        if (zip.getEntry(entry) == null) null else "zip:${apk.absolutePath}!$entry"
                    }
                } catch (_: Exception) {
                    null
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun densityFor(directory: String): Int? =
        when (directory.substringAfter('-', "")) {
            "ldpi" -> 120
            "mdpi" -> 160
            "tvdpi" -> 213
            "hdpi" -> 240
            "xhdpi" -> 320
            "xxhdpi" -> 480
            "xxxhdpi" -> 640
            "nodpi", "anydpi" -> TypedValue.DENSITY_NONE
            else -> null
        }

    private fun copyLocatorIfMatches(
        locator: String,
        expectedHash: String,
        destination: File,
    ): Boolean {
        val input = openLocator(locator) ?: return false
        val tempFile = File(destination.parentFile, "${destination.name}.builtin.tmp")
        return try {
            destination.parentFile?.mkdirs()
            val digest = MessageDigest.getInstance("SHA-256")
            input.use { source ->
                tempFile.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = source.read(buffer)
                        if (count < 0) break
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            }
            val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actualHash.equals(expectedHash, ignoreCase = true)) {
                tempFile.delete()
                false
            } else {
                if (destination.exists()) destination.delete()
                tempFile.renameTo(destination) ||
                    run {
                        tempFile.copyTo(destination, overwrite = true)
                        tempFile.delete()
                        true
                    }
            }
        } catch (_: Exception) {
            tempFile.delete()
            false
        }
    }

    private fun openLocator(locator: String): InputStream? {
        return try {
            when {
                locator.startsWith("asset:") -> {
                    context.assets.open(locator.removePrefix("asset:"))
                }

                locator.startsWith("zip:") -> {
                    val separator = locator.indexOf('!', startIndex = 4)
                    if (separator < 0) return null
                    val apk = File(locator.substring(4, separator))
                    if (installedApks().none { it.absolutePath == apk.absolutePath }) return null
                    val zip = ZipFile(apk)
                    val entry =
                        zip.getEntry(locator.substring(separator + 1)) ?: run {
                            zip.close()
                            return null
                        }
                    val stream = zip.getInputStream(entry)
                    object : InputStream() {
                        override fun read(): Int = stream.read()

                        override fun read(
                            buffer: ByteArray,
                            offset: Int,
                            length: Int,
                        ): Int = stream.read(buffer, offset, length)

                        override fun close() {
                            stream.close()
                            zip.close()
                        }
                    }
                }

                else -> {
                    null
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun installedApks(): List<File> {
        val info = context.applicationInfo
        return (listOf(info.sourceDir) + info.splitSourceDirs.orEmpty())
            .filterNotNull()
            .map(::File)
            .filter(File::isFile)
    }

    private fun packageIdentity(): String? =
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            val versionCode =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    packageInfo.longVersionCode
                } else {
                    @Suppress("DEPRECATION")
                    packageInfo.versionCode.toLong()
                }
            buildString {
                append(context.packageName)
                append('|')
                append(versionCode)
                append('|')
                append(packageInfo.lastUpdateTime)
                installedApks().sortedBy(File::getAbsolutePath).forEach { apk ->
                    append('|')
                    append(apk.absolutePath)
                    append(':')
                    append(apk.length())
                    append(':')
                    append(apk.lastModified())
                }
            }
        } catch (_: Exception) {
            null
        }

    private fun readIndex(packageIdentity: String): CachedIndex {
        try {
            if (cacheFile.isFile) {
                val json = JSONObject(cacheFile.readText())
                if (json.optInt("schemaVersion") == SCHEMA_VERSION &&
                    json.optString("packageIdentity") == packageIdentity
                ) {
                    val locatorsJson = json.optJSONObject("locators") ?: JSONObject()
                    val locators = mutableMapOf<String, String>()
                    locatorsJson.keys().forEach { path -> locators[path] = locatorsJson.getString(path) }
                    return CachedIndex(packageIdentity, locators)
                }
            }
        } catch (_: Exception) {
            // A corrupt cache is only a missed optimization.
        }
        return CachedIndex(packageIdentity, mutableMapOf())
    }

    private fun writeIndex(index: CachedIndex) {
        try {
            cacheFile.parentFile?.mkdirs()
            val json =
                JSONObject()
                    .put("schemaVersion", SCHEMA_VERSION)
                    .put("packageIdentity", index.packageIdentity)
                    .put("locators", JSONObject(index.locators.toSortedMap()))
            val tempFile = File(cacheFile.parentFile, "${cacheFile.name}.tmp")
            tempFile.writeText("$json\n")
            if (cacheFile.exists()) cacheFile.delete()
            if (!tempFile.renameTo(cacheFile)) tempFile.delete()
        } catch (_: Exception) {
            // Cache persistence must never block a valid install.
        }
    }

    companion object {
        private const val SCHEMA_VERSION = 1
    }
}
