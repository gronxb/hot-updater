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

        /**
         * Function to finalize and apply the existing stable bundle.
         */
        @Volatile
        private var prefsInstance: HotUpdaterPrefs? = null

        @Volatile
        private var cachedAppVersion: String? = null

        private fun getPrefs(context: Context): HotUpdaterPrefs {
            val appContext = context.applicationContext
            val currentAppVersion = getAppVersion(appContext) ?: "unknown"
            synchronized(this) {
                if (prefsInstance == null || cachedAppVersion != currentAppVersion) {
                    prefsInstance = HotUpdaterPrefs(appContext, currentAppVersion)
                    cachedAppVersion = currentAppVersion
                }
                return prefsInstance!!
            }
        }

        private fun setBundleURL(
            context: Context,
            bundleURL: String?,
        ) {
            val updaterPrefs = getPrefs(context)
            updaterPrefs.setItem("HotUpdaterBundleURL", bundleURL)

            if (bundleURL == null) {
                return
            }
            val reactIntegrationManager = ReactIntegrationManager(context)
            val activity: Activity? = getCurrentActivity(context)
            val reactApplication: ReactApplication = reactIntegrationManager.getReactApplication(activity?.application)
            reactIntegrationManager.setJSBundle(reactApplication, bundleURL)
        }

        /**
         * Function to apply a provisional bundle.
         * Applies the new bundle immediately after download, but keeps it provisional until notifyAppReady is called.
         */
        private fun setProvisionalBundleURL(
            context: Context,
            bundleURL: String,
        ) {
            val sharedPreferences = context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            with(sharedPreferences.edit()) {
                putString("HotUpdaterPendingBundleURL", bundleURL)
                apply()
            }
            val reactIntegrationManager = ReactIntegrationManager(context)
            val activity: Activity? = getCurrentActivity(context)
            val reactApplication: ReactApplication = reactIntegrationManager.getReactApplication(activity?.application)
            reactIntegrationManager.setJSBundle(reactApplication, bundleURL)
            Log.d("HotUpdater", "Provisional bundle set: $bundleURL")
        }

        /**
         * Called after the app has successfully launched to confirm the provisional bundle.
         */
        fun notifyAppReady(context: Context) {
            val sharedPreferences = context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            val pendingBundleURL = sharedPreferences.getString("HotUpdaterPendingBundleURL", null)
            if (pendingBundleURL != null) {
                // 임시 번들을 확정하여 안정 번들로 옮김.
                with(sharedPreferences.edit()) {
                    putString("HotUpdaterBundleURL", pendingBundleURL)
                    remove("HotUpdaterPendingBundleURL")
                    apply()
                }
                Log.d("HotUpdater", "Bundle confirmed as ready: $pendingBundleURL")
            } else {
                Log.d("HotUpdater", "No pending bundle found to confirm.")
            }
        }

        /**
         * 앱 재시작 시 호출되는 getJSBundleFile.
         * 여기서 pending 상태가 남아 있다면 롤백 처리하여 안정 번들을 사용하도록 함.
         */
        fun getJSBundleFile(context: Context): String {
            val sharedPreferences = context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            // 롤백 처리: 이전 업데이트가 확정되지 않은 경우, pending 항목 삭제
            if (sharedPreferences.contains("HotUpdaterPendingBundleURL")) {
                sharedPreferences.edit().remove("HotUpdaterPendingBundleURL").apply()
                Log.d("HotUpdater", "Rollback executed: pending update not confirmed.")
            }
            val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }
            val file = File(urlString)
            if (!file.exists()) {
                sharedPreferences.edit().remove("HotUpdaterBundleURL").apply()
                return "assets://index.android.bundle"
            }
            return urlString
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
            val updaterPrefs = getPrefs(context)
            val urlString = updaterPrefs.getItem("HotUpdaterBundleURL")
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }

            val file = File(urlString)
            if (!file.exists()) {
                updaterPrefs.setItem("HotUpdaterBundleURL", null)
                return "assets://index.android.bundle"
            }
            return urlString
        }

        fun setChannel(
            context: Context,
            channel: String,
        ) {
            val updaterPrefs = getPrefs(context)
            updaterPrefs.setItem("HotUpdaterChannel", channel)
        }

        fun getChannel(context: Context): String? {
            val updaterPrefs = getPrefs(context)
            return updaterPrefs.getItem("HotUpdaterChannel")
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
                    finalBundleDir.setLastModified(System.currentTimeMillis())
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

            val tempZipFile = File(tempDir, "bundle.zip")
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
                            tempDir.deleteRecursively()
                            return@withContext false
                        }

                    try {
                        conn.connect()
                        val totalSize = conn.contentLength
                        if (totalSize <= 0) {
                            Log.d("HotUpdater", "Invalid content length: $totalSize")
                            tempDir.deleteRecursively()
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
                        tempDir.deleteRecursively()
                        return@withContext false
                    } finally {
                        conn.disconnect()
                    }

                    if (!extractZipFileAtPath(tempZipFile.absolutePath, extractedDir.absolutePath)) {
                        Log.d("HotUpdater", "Failed to extract zip file.")
                        tempDir.deleteRecursively()
                        return@withContext false
                    }
                    true
                }

            if (!isSuccess) {
                tempDir.deleteRecursively()
                return false
            }

            val indexFileExtracted = extractedDir.walk().find { it.name == "index.android.bundle" }
            if (indexFileExtracted == null) {
                Log.d("HotUpdater", "index.android.bundle not found in extracted files.")
                tempDir.deleteRecursively()
                return false
            }

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
                tempDir.deleteRecursively()
                return false
            }

            finalBundleDir.setLastModified(System.currentTimeMillis())
            val bundlePath = finalIndexFile.absolutePath
            Log.d("HotUpdater", "Setting provisional bundle URL: $bundlePath")
            setProvisionalBundleURL(context, bundlePath)

            // Clean up old bundles in the bundle store to keep only up to 2 bundles
            Log.d("HotUpdater", "Setting bundle URL: $bundlePath")
            setBundleURL(context, bundlePath)
            cleanupOldBundles(bundleStoreDir)
            tempDir.deleteRecursively()

            Log.d("HotUpdater", "Downloaded and extracted file successfully.")
            return true
        }

        private fun cleanupOldBundles(bundleStoreDir: File) {
            val bundles = bundleStoreDir.listFiles { file -> file.isDirectory }?.toList() ?: return
            val sortedBundles = bundles.sortedByDescending { it.lastModified() }
            if (sortedBundles.size > 1) {
                sortedBundles.drop(1).forEach { oldBundle ->
                    Log.d("HotUpdater", "Removing old bundle: ${oldBundle.name}")
                    oldBundle.deleteRecursively()
                }
            }
        }

        fun getMinBundleId(): String =
            try {
                val buildTimestampMs = BuildConfig.BUILD_TIMESTAMP
                val bytes =
                    ByteArray(16).apply {
                        this[0] = ((buildTimestampMs shr 40) and 0xFF).toByte()
                        this[1] = ((buildTimestampMs shr 32) and 0xFF).toByte()
                        this[2] = ((buildTimestampMs shr 24) and 0xFF).toByte()
                        this[3] = ((buildTimestampMs shr 16) and 0xFF).toByte()
                        this[4] = ((buildTimestampMs shr 8) and 0xFF).toByte()
                        this[5] = (buildTimestampMs and 0xFF).toByte()
                        this[6] = 0x70.toByte()
                        this[7] = 0x00.toByte()
                        this[8] = 0x80.toByte()
                        this[9] = 0x00.toByte()
                        this[10] = 0x00.toByte()
                        this[11] = 0x00.toByte()
                        this[12] = 0x00.toByte()
                        this[13] = 0x00.toByte()
                        this[14] = 0x00.toByte()
                        this[15] = 0x00.toByte()
                    }
                String.format(
                    "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                    bytes[0].toInt() and 0xFF,
                    bytes[1].toInt() and 0xFF,
                    bytes[2].toInt() and 0xFF,
                    bytes[3].toInt() and 0xFF,
                    bytes[4].toInt() and 0xFF,
                    bytes[5].toInt() and 0xFF,
                    bytes[6].toInt() and 0xFF,
                    bytes[7].toInt() and 0xFF,
                    bytes[8].toInt() and 0xFF,
                    bytes[9].toInt() and 0xFF,
                    bytes[10].toInt() and 0xFF,
                    bytes[11].toInt() and 0xFF,
                    bytes[12].toInt() and 0xFF,
                    bytes[13].toInt() and 0xFF,
                    bytes[14].toInt() and 0xFF,
                    bytes[15].toInt() and 0xFF,
                )
            } catch (e: Exception) {
                "00000000-0000-0000-0000-000000000000"
            }
    }
}
