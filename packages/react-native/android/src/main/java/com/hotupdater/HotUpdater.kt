package com.hotupdater

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import com.facebook.react.ReactApplication
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipFile

class HotUpdater : ReactPackage {
    override fun createViewManagers(context: ReactApplicationContext): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    override fun createNativeModules(context: ReactApplicationContext): MutableList<NativeModule> =
        listOf(HotUpdaterModule(context)).toMutableList()

    companion object {
        private fun convertFileSystemPathFromBasePath(
            context: Context,
            basePath: String,
        ): String {
            val documentsDir =
                context.getExternalFilesDir(null)?.absolutePath ?: context.filesDir.absolutePath
            val separator = if (basePath.startsWith("/")) "" else "/"
            return "$documentsDir$separator$basePath"
        }

        private fun stripPrefixFromPath(
            prefix: String,
            path: String,
        ): String =
            if (path.startsWith("/$prefix/")) {
                path.replaceFirst("/$prefix/", "")
            } else {
                path
            }

        fun getAppVersion(context: Context): String? {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            return packageInfo.versionName
        }

        private fun setBundleURL(
            context: Context,
            bundleURL: String?,
        ) {
            val sharedPreferences =
                context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            with(sharedPreferences.edit()) {
                putString("HotUpdaterBundleURL", bundleURL)
                apply()
            }

            if (bundleURL == null) {
                return
            }

            val reactIntegrationManager = ReactIntegrationManager(context)
            val activity: Activity? = getCurrentActivity(context)
            val reactApplication: ReactApplication =
                reactIntegrationManager.getReactApplication(activity?.application)
            val newBundleURL = getJSBundleFile(context)
            reactIntegrationManager.setJSBundle(reactApplication, newBundleURL)
        }

        private fun extractZipFileAtPath(
            filePath: String,
            destinationPath: String,
        ): Boolean =
            try {
                ZipFile(filePath).use { zip ->
                    zip.entries().asSequence().forEach { entry ->
                        val file = File(destinationPath, entry.name)
                        if (entry.isDirectory) {
                            file.mkdirs()
                        } else {
                            file.parentFile?.mkdirs()
                            zip.getInputStream(entry).use { input ->
                                file.outputStream().use { output -> input.copyTo(output) }
                            }
                        }
                    }
                }
                true
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to unzip file: ${e.message}")
                false
            }

        private fun getCurrentActivity(context: Context): Activity? =
            if (context is ReactApplicationContext) {
                context.currentActivity
            } else {
                null
            }

        fun reload(context: Context) {
            val reactIntegrationManager = ReactIntegrationManager(context)
            val activity: Activity? = getCurrentActivity(context)
            val reactApplication: ReactApplication =
                reactIntegrationManager.getReactApplication(activity?.application)
            val bundleURL = getJSBundleFile(context)
            reactIntegrationManager.setJSBundle(reactApplication, bundleURL)
            Handler(Looper.getMainLooper()).post {
                reactIntegrationManager.reload(reactApplication)
            }
        }

        fun getJSBundleFile(context: Context): String {
            val sharedPreferences =
                context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }

            val file = File(urlString)
            if (!file.exists()) {
                setBundleURL(context, null)
                return "assets://index.android.bundle"
            }

            return urlString
        }

        suspend fun updateBundle(
            context: Context,
            bundleId: String,
            zipUrl: String?,
            progressCallback: ((Double) -> Unit),
        ): Boolean {
            Log.d("HotUpdater", "updateBundle bundleId $bundleId zipUrl $zipUrl")
            if (zipUrl.isNullOrEmpty()) {
                setBundleURL(context, null)
                return true
            }

            val downloadUrl = URL(zipUrl)
            val basePath = stripPrefixFromPath(bundleId, downloadUrl.path)
            val path = convertFileSystemPathFromBasePath(context, basePath)

            val isSuccess =
                withContext(Dispatchers.IO) {
                    val conn =
                        try {
                            downloadUrl.openConnection() as HttpURLConnection
                        } catch (e: Exception) {
                            Log.d("HotUpdater", "Failed to open connection: ${e.message}")
                            return@withContext false
                        }

                    try {
                        conn.connect()
                        val totalSize = conn.contentLength
                        if (totalSize <= 0) {
                            Log.d("HotUpdater", "Invalid content length: $totalSize")
                            return@withContext false
                        }

                        val file = File(path)
                        file.parentFile?.mkdirs()

                        conn.inputStream.use { input ->
                            file.outputStream().use { output ->
                                val buffer = ByteArray(8 * 1024)
                                var bytesRead: Int
                                var totalRead = 0L
                                var lastProgressTime = System.currentTimeMillis()

                                while (input.read(buffer).also { bytesRead = it } != -1) {
                                    output.write(buffer, 0, bytesRead)
                                    totalRead += bytesRead
                                    val currentTime = System.currentTimeMillis()
                                    if (currentTime - lastProgressTime >= 100) { // Check every 100ms
                                        val progress = totalRead.toDouble() / totalSize
                                        progressCallback.invoke(progress)
                                        lastProgressTime = currentTime
                                    }
                                }
                                // Send final progress (100%) after download completes
                                progressCallback.invoke(1.0)
                            }
                        }
                    } catch (e: Exception) {
                        Log.d("HotUpdater", "Failed to download data from URL: $zipUrl, Error: ${e.message}")
                        return@withContext false
                    } finally {
                        conn.disconnect()
                    }

                    val extractedPath = File(path).parentFile?.path ?: return@withContext false

                    if (!extractZipFileAtPath(path, extractedPath)) {
                        Log.d("HotUpdater", "Failed to extract zip file.")
                        return@withContext false
                    }

                    val extractedDirectory = File(extractedPath)
                    val indexFile = extractedDirectory.walk().find { it.name == "index.android.bundle" }

                    if (indexFile != null) {
                        val bundlePath = indexFile.path
                        Log.d("HotUpdater", "Setting bundle URL: $bundlePath")
                        setBundleURL(context, bundlePath)
                    } else {
                        Log.d("HotUpdater", "index.android.bundle not found.")
                        return@withContext false
                    }

                    Log.d("HotUpdater", "Downloaded and extracted file successfully.")
                    true
                }
            return isSuccess
        }
    }
}
