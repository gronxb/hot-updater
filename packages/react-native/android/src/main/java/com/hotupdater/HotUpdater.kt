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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.util.zip.ZipFile

class HotUpdater : ReactPackage {
    override fun createViewManagers(context: ReactApplicationContext): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    override fun createNativeModules(context: ReactApplicationContext): MutableList<NativeModule> =
        listOf(HotUpdaterModule(context)).toMutableList()

    companion object {
        private const val TAG = "HotUpdater"
        private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

        fun getAppVersion(context: Context): String? {
            val version = HotUpdaterUtils.getAppVersion(context)
            Log.d(TAG, "Retrieved app version: $version")
            return version
        }

        @Volatile
        private var prefsInstance: HotUpdaterPrefs? = null

        @Volatile
        private var cachedAppVersion: String? = null

        private fun getPrefs(context: Context): HotUpdaterPreferenceManager {
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
            Log.d(TAG, "Bundle URL preference set to: $bundleURL")

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
            val reloader = ReactNativeReloader(context)
            val url = reloader.getCurrentBundleUrl()
            Log.d(TAG, "Providing JS bundle file: $url")
            return url
        }

        fun setChannel(
            context: Context,
            channel: String,
        ) {
            getPrefs(context).setItem(HotUpdaterPreferenceManager.KEY_CHANNEL, channel)
            Log.d(TAG, "Channel set to: $channel")
        }

        fun getChannel(context: Context): String? = getPrefs(context).getItem(HotUpdaterPreferenceManager.KEY_CHANNEL)

        @JvmStatic
        fun updateBundle(
            context: Context,
            bundleId: String,
            zipUrl: String?,
            progressCallback: ((Double) -> Unit),
            completionCallback: ((Boolean) -> Unit),
        ) {
            Log.d(TAG, "updateBundle (async) called for bundleId: $bundleId, zipUrl: $zipUrl")
            CoroutineScope(Dispatchers.IO + SupervisorJob()).launch {
                var success = false
                val fileManager = BundleFileManager(context)
                val prefs = getPrefs(context)
                val reloader = ReactNativeReloader(context)

                try {
                    if (zipUrl.isNullOrEmpty()) {
                        Log.d(TAG, "zipUrl is null or empty. Reverting to default bundle.")
                        prefs.setItem(HotUpdaterPreferenceManager.KEY_BUNDLE_URL, null)
                        success = true
                        return@launch
                    }

                    val finalBundleDir = File(fileManager.getBundleStoreDirectory(), bundleId)
                    if (finalBundleDir.exists()) {
                        val existingIndexFile = fileManager.findIndexBundle(finalBundleDir)
                        if (existingIndexFile != null) {
                            Log.d(TAG, "Bundle $bundleId already exists and is valid. Using cached bundle.")
                            finalBundleDir.setLastModified(System.currentTimeMillis())
                            prefs.setItem(HotUpdaterPreferenceManager.KEY_BUNDLE_URL, existingIndexFile.absolutePath)
                            fileManager.cleanupOldBundles()
                            success = true
                            return@launch
                        } else {
                            Log.w(TAG, "Bundle directory $bundleId exists but index file is missing. Redownloading.")
                            finalBundleDir.deleteRecursively()
                        }
                    }

                    Log.d(TAG, "Starting download from: $zipUrl")
                    val tempZipFile = fileManager.downloadBundle(zipUrl, progressCallback)
                    if (tempZipFile == null) {
                        Log.e(TAG, "Bundle download failed.")
                        return@launch
                    }
                    Log.d(TAG, "Download completed: ${tempZipFile.absolutePath}")

                    Log.d(TAG, "Starting extraction of: ${tempZipFile.name}")
                    val extractedDir = fileManager.extractBundle(tempZipFile)
                    if (extractedDir == null) {
                        Log.e(TAG, "Bundle extraction failed.")
                        return@launch
                    }
                    Log.d(TAG, "Extraction completed to: ${extractedDir.absolutePath}")

                    Log.d(TAG, "Installing bundle $bundleId")
                    val finalIndexFile = fileManager.installBundle(extractedDir, bundleId)
                    if (finalIndexFile == null) {
                        Log.e(TAG, "Bundle installation failed for $bundleId.")
                        return@launch
                    }
                    Log.d(TAG, "Installation completed. Final index file: ${finalIndexFile.absolutePath}")

                    prefs.setItem(HotUpdaterPreferenceManager.KEY_BUNDLE_URL, finalIndexFile.absolutePath)

                    fileManager.cleanupOldBundles()
                    success = true
                    Log.d(TAG, "Bundle update process completed successfully for $bundleId.")
                } catch (e: Exception) {
                    Log.e(TAG, "Error during bundle update process for $bundleId: ${e.message}", e)
                    success = false
                } finally {
                    fileManager.cleanupTemporaryFiles()
                    launch(Dispatchers.Main) {
                        completionCallback(success)
                    }
                }
            }
        }

        fun getMinBundleId(): String {
            val id = HotUpdaterUtils.getMinBundleId()
            Log.d(TAG, "Retrieved min bundle ID: $id")
            return id
        }
    }
}
