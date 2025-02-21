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

            val baseDir = context.getExternalFilesDir(null)
            val bundleStoreDir = File(baseDir, "bundle-store")
            if (!bundleStoreDir.exists()) {
                bundleStoreDir.mkdirs()
            }

            val finalBundleDir = File(bundleStoreDir, bundleId)
            if (finalBundleDir.exists()) {
                Log.d("HotUpdater", "Bundle for bundleId $bundleId already exists. Using cached bundle.")
                val existingIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                if (existingIndexFile != null) {
                    setBundleURL(context, existingIndexFile.absolutePath)
                    cleanupOldBundles(bundleStoreDir)
                    return true
                } else {
                    finalBundleDir.deleteRecursively()
                }
            }

            val tempDir = File(baseDir, "bundle-temp")
            if (tempDir.exists()) {
                tempDir.deleteRecursively()
            }
            tempDir.mkdirs()

            val tempZipFile = File(tempDir, "build.zip")
            val extractedDir = File(tempDir, "extracted")
            extractedDir.mkdirs()

            val isSuccess =
                withContext(Dispatchers.IO) {
                    val downloadUrl = URL(zipUrl)
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
                        conn.inputStream.use { input ->
                            tempZipFile.outputStream().use { output ->
                                val buffer = ByteArray(8 * 1024)
                                var bytesRead: Int
                                var totalRead = 0L
                                var lastProgressTime = System.currentTimeMillis()

                                while (input.read(buffer).also { bytesRead = it } != -1) {
                                    output.write(buffer, 0, bytesRead)
                                    totalRead += bytesRead
                                    val currentTime = System.currentTimeMillis()
                                    if (currentTime - lastProgressTime >= 100) {
                                        val progress = totalRead.toDouble() / totalSize
                                        progressCallback.invoke(progress)
                                        lastProgressTime = currentTime
                                    }
                                }
                                progressCallback.invoke(1.0)
                            }
                        }
                    } catch (e: Exception) {
                        Log.d("HotUpdater", "Failed to download data from URL: $zipUrl, Error: ${e.message}")
                        return@withContext false
                    } finally {
                        conn.disconnect()
                    }

                    if (!extractZipFileAtPath(tempZipFile.absolutePath, extractedDir.absolutePath)) {
                        Log.d("HotUpdater", "Failed to extract zip file.")
                        return@withContext false
                    }
                    true
                }

            if (!isSuccess) return false

            val indexFileExtracted = extractedDir.walk().find { it.name == "index.android.bundle" }
            if (indexFileExtracted == null) {
                Log.d("HotUpdater", "index.android.bundle not found in extracted files.")
                return false
            }

            // Move (or copy) contents from temp folder to finalBundleDir
            if (finalBundleDir.exists()) {
                finalBundleDir.deleteRecursively()
            }
            if (!extractedDir.renameTo(finalBundleDir)) {
                extractedDir.copyRecursively(finalBundleDir, overwrite = true)
                extractedDir.deleteRecursively()
            }

            val finalIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (finalIndexFile == null) {
                Log.d("HotUpdater", "index.android.bundle not found in final directory.")
                return false
            }

            val bundlePath = finalIndexFile.absolutePath
            Log.d("HotUpdater", "Setting bundle URL: $bundlePath")
            setBundleURL(context, bundlePath)

            // Clean up old bundles in the bundle store to keep only up to 2 bundles
            cleanupOldBundles(bundleStoreDir)

            Log.d("HotUpdater", "Downloaded and extracted file successfully.")
            return true
        }

        // Helper function to delete old bundles, keeping only up to 2 bundles in the bundle-store folder
        private fun cleanupOldBundles(bundleStoreDir: File) {
            // Get list of all directories in bundle-store
            val bundles = bundleStoreDir.listFiles { file -> file.isDirectory }?.toList() ?: return
            // Sort by uuidv7 string in descending order => oldest bundles at the bottom
            val sortedBundles = bundles.sortedByDescending { it.name }
            // If more than 2 bundles exist, delete from the 3rd one onwards
            if (sortedBundles.size > 2) {
                sortedBundles.drop(2).forEach { oldBundle ->
                    Log.d("HotUpdater", "Removing old bundle: ${oldBundle.name}")
                    oldBundle.deleteRecursively()
                }
            }
        }
    }
}
