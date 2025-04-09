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
         * Preference instance는 앱 버전 기준으로 캐싱됨.
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

        /**
         * 안정 번들을 설정하고, React의 JS 번들로 적용함.
         */
        private fun setBundleURL(
            context: Context,
            bundleURL: String?,
        ) {
            val prefs = getPrefs(context)
            prefs.setItem("HotUpdaterBundleURL", bundleURL)

            if (bundleURL == null) {
                return
            }
            val reactIntegrationManager = ReactIntegrationManager(context)
            val activity: Activity? = getCurrentActivity(context)
            val reactApplication: ReactApplication =
                reactIntegrationManager.getReactApplication(activity?.application)
            reactIntegrationManager.setJSBundle(reactApplication, bundleURL)
        }

        /**
         * JS 측에서 앱이 정상 실행된 후 호출되어, 신규 업데이트를 확정함.
         * 호출되면 provisional 플래그를 제거하고 이전(백업) 번들을 삭제함.
         */
        fun notifyAppReady(context: Context) {
            val prefs = getPrefs(context)
            if (prefs.getItem("HotUpdaterProvisional") == "true") {
                prefs.removeItem("HotUpdaterProvisional")
                prefs.removeItem("HotUpdaterPrevBundleURL")
                Log.d("HotUpdater", "New bundle confirmed as stable.")
            } else {
                Log.d("HotUpdater", "No provisional bundle found to confirm.")
            }
        }

        /**
         * 앱 실행 시 호출되어, 사용할 JS 번들을 결정함.
         * 만약 신규 업데이트가 provisional 상태라면, 이전 안정 번들을 반환하여 롤백함.
         */
        fun getJSBundleFile(context: Context): String {
            val prefs = getPrefs(context)
            // 신규 업데이트가 확정되지 않은 상태이면 롤백 시도
            if (prefs.getItem("HotUpdaterProvisional") == "true") {
                val prev = prefs.getItem("HotUpdaterPrevBundleURL")
                if (!prev.isNullOrEmpty() && File(prev).exists()) {
                    Log.d("HotUpdater", "Rollback: Using previous stable bundle: $prev")
                    return prev
                } else {
                    // 백업 파일이 없으면 provisional 플래그 제거
                    prefs.removeItem("HotUpdaterProvisional")
                }
            }

            // 안정 번들을 반환
            val stable = prefs.getItem("HotUpdaterBundleURL")
            if (!stable.isNullOrEmpty()) {
                if (File(stable).exists()) return stable
                prefs.removeItem("HotUpdaterBundleURL")
            }
            return "assets://index.android.bundle"
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
                                file.outputStream().use { output ->
                                    input.copyTo(output)
                                }
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

        /**
         * 번들을 업데이트하는 함수.
         * 다운로드 및 압축 해제 성공 시,
         * 업데이트 전에 기존 안정 번들을 백업("HotUpdaterPrevBundleURL")하고,
         * 신규 업데이트를 provisional 상태("HotUpdaterProvisional" = "true")로 적용한 후, JS 번들로 설정함.
         */
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
            Log.d("HotUpdater", "New bundle ready: $bundlePath")

            // 업데이트 직전에 기존 안정 번들을 백업.
            val prefs = getPrefs(context)
            val currentStable = prefs.getItem("HotUpdaterBundleURL")
            if (!currentStable.isNullOrEmpty()) {
                prefs.setItem("HotUpdaterPrevBundleURL", currentStable)
            }

            // 신규 업데이트를 provisional 상태로 표기.
            prefs.setItem("HotUpdaterProvisional", "true")

            Log.d("HotUpdater", "Applying new bundle URL: $bundlePath")
            setBundleURL(context, bundlePath)
            cleanupOldBundles(bundleStoreDir)
            tempDir.deleteRecursively()

            Log.d("HotUpdater", "Downloaded and applied new bundle successfully.")
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
