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
            val hotUpdaterDir = File(documentsDir, "HotUpdater")
            if (!hotUpdaterDir.exists()) {
                hotUpdaterDir.mkdirs()
            }
            val updateDir = File(hotUpdaterDir, basePath)
            if (!updateDir.exists()) {
                updateDir.mkdirs()
            }
            return File(updateDir, "update.zip").absolutePath
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
            val reactIntegrationManager = ReactIntegrationManager(context)
            val activity: Activity? = getCurrentActivity(context)
            val reactApplication: ReactApplication =
                reactIntegrationManager.getReactApplication(activity?.application)
            val jsBundle = getJSBundleFile(context)
            reactIntegrationManager.setJSBundle(reactApplication, jsBundle)
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
            val jsBundle = getJSBundleFile(context)
            reactIntegrationManager.setJSBundle(reactApplication, jsBundle)
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

        /**
         * 현재 업데이트 폴더(currentUpdateDir) 이외의 HotUpdater 하위 모든 폴더를 삭제하여
         * 불필요한 파일 누적으로 인한 디스크 누수를 방지합니다.
         */
        private fun cleanupOldBundlesExceptCurrent(
            context: Context,
            currentUpdateDir: String,
        ) {
            val documentsDir =
                context.getExternalFilesDir(null)?.absolutePath ?: context.filesDir.absolutePath
            val hotUpdaterDir = File(documentsDir, "HotUpdater")
            if (!hotUpdaterDir.exists()) return
            hotUpdaterDir.listFiles()?.forEach { file ->
                if (file.absolutePath != currentUpdateDir) {
                    file.deleteRecursively()
                    Log.d("HotUpdater", "Removed old bundle directory: ${file.absolutePath}")
                }
            }
        }

        fun updateBundle(
            context: Context,
            bundleId: String,
            zipUrl: String,
            progressCallback: ((Double) -> Unit),
        ): Boolean {
            Log.d("HotUpdater", "updateBundle bundleId $bundleId zipUrl $zipUrl")
            if (zipUrl.isEmpty()) {
                setBundleURL(context, null)
                return true
            }

            val downloadUrl = URL(zipUrl)
            val basePath = stripPrefixFromPath(bundleId, downloadUrl.path)
            val path = convertFileSystemPathFromBasePath(context, basePath)
            val updateDir = File(path).parentFile ?: return false

            var connection: HttpURLConnection? = null
            try {
                connection = downloadUrl.openConnection() as HttpURLConnection
                connection.connect()

                val totalSize = connection.contentLength
                if (totalSize <= 0) {
                    Log.d("HotUpdater", "Invalid content length: $totalSize")
                    return false
                }

                val file = File(path)
                file.parentFile?.mkdirs()

                connection.inputStream.use { input ->
                    file.outputStream().use { output ->
                        val buffer = ByteArray(8 * 1024)
                        var bytesRead: Int
                        var totalRead = 0L

                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            totalRead += bytesRead
                            val progress = (totalRead.toDouble() / totalSize)
                            progressCallback.invoke(progress)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to download data from URL: $zipUrl, Error: ${e.message}")
                return false
            } finally {
                connection?.disconnect()
            }

            val extractedPath = updateDir.absolutePath
            if (!extractZipFileAtPath(path, extractedPath)) {
                Log.d("HotUpdater", "Failed to extract zip file.")
                return false
            }

            val indexFile = updateDir.walk().find { it.name == "index.android.bundle" }

            if (indexFile != null) {
                val bundlePath = indexFile.path
                Log.d("HotUpdater", "Setting bundle URL: $bundlePath")
                setBundleURL(context, bundlePath)
            } else {
                Log.d("HotUpdater", "index.android.bundle not found.")
                return false
            }

            Log.d("HotUpdater", "Downloaded and extracted file successfully.")
            return true
        }
    }
}
