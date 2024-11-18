package com.hotupdater

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceManager
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.lang.reflect.Field
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
            val documentsDir = context.getExternalFilesDir(null)?.absolutePath ?: context.filesDir.absolutePath
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

        private fun loadBundleLegacy(activity: Activity?) {
            if (activity == null) {
                return
            }

            activity.runOnUiThread { activity.recreate() }
        }

        private var mLifecycleEventListener: LifecycleEventListener? = null

        private fun clearLifecycleEventListener(reactNativeHost: ReactNativeHost) {
            if (mLifecycleEventListener != null) {
                reactNativeHost.reactInstanceManager.currentReactContext?.removeLifecycleEventListener(
                    mLifecycleEventListener,
                )
                mLifecycleEventListener = null
            }
        }

        private fun setJSBundle(
            instanceManager: ReactInstanceManager,
            latestJSBundleFile: String?,
        ) {
            try {
                var latestJSBundleLoader: JSBundleLoader? = null

                if (latestJSBundleFile != null && latestJSBundleFile.lowercase().startsWith("assets://")
                ) {
                    latestJSBundleLoader =
                        JSBundleLoader.createAssetLoader(
                            instanceManager.currentReactContext,
                            latestJSBundleFile,
                            false,
                        )
                } else if (latestJSBundleFile != null) {
                    latestJSBundleLoader = JSBundleLoader.createFileLoader(latestJSBundleFile)
                }
                val bundleLoaderField: Field =
                    instanceManager::class.java.getDeclaredField("mBundleLoader")
                bundleLoaderField.isAccessible = true

                if (latestJSBundleLoader != null) {
                    bundleLoaderField.set(instanceManager, latestJSBundleLoader)
                } else {
                    bundleLoaderField.set(instanceManager, null)
                }
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
                throw IllegalAccessException("Could not setJSBundle")
            }
        }

        private fun getReactNativeHost(application: Application?): ReactNativeHost {
            if (application is ReactApplication) {
                return application.reactNativeHost
            } else {
                throw IllegalArgumentException("Application does not implement ReactApplication")
            }
        }

        private fun getReactHost(application: Application?): ReactHost? {
            if (application is ReactApplication) {
                return application.reactHost
            } else {
                throw IllegalArgumentException("Application does not implement ReactApplication")
            }
        }

        fun getAppVersion(context: Context): String? {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            return packageInfo.versionName
        }

        fun getBundleURL(context: Context): String {
            val sharedPreferences =
                context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }

            Log.d("HotUpdater", "GetBundleURL: $urlString")
            return urlString
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
            val activity: Activity? = getCurrentActivity(context)
            val reactNativeHost: ReactNativeHost = this.getReactNativeHost(activity?.application)
            val reactHost: ReactHost? = this.getReactHost(activity?.application)

            Log.d("HotUpdater", "HotUpdater requested a reload ${getBundleURL(context)}")

            setJSBundle(reactNativeHost.reactInstanceManager, getBundleURL(context))

            clearLifecycleEventListener(reactNativeHost)
            try {
                Handler(Looper.getMainLooper()).post {
                    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
                        check(reactHost != null)
                        if (reactHost.lifecycleState != LifecycleState.RESUMED && activity != null) {
                            reactHost.onHostResume(activity)
                        }
                        reactHost.reload("HotUpdater requested a reload")
                    } else {
                        try {
                            reactNativeHost.reactInstanceManager.recreateReactContextInBackground()
                        } catch (t: Throwable) {
                            loadBundleLegacy(activity)
                        }
                    }
                }
            } catch (t: Throwable) {
                loadBundleLegacy(activity)
            }
        }

        fun getJSBundleFile(context: Context): String? {
            Log.d("HotUpdater", "Getting JS bundle file ${getBundleURL(context)}")
            val sharedPreferences =
                context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }

            Log.d("HotUpdater", "GetBundleURL: $urlString")
            return urlString
        }

        fun updateBundle(
            context: Context,
            bundleId: String,
            zipUrl: String,
        ): Boolean? {
            if (zipUrl.isEmpty()) {
                setBundleURL(context, null)
                return true
            }

            val downloadUrl = URL(zipUrl)

            val basePath = stripPrefixFromPath(bundleId, downloadUrl.path)
            val path = convertFileSystemPathFromBasePath(context, basePath)

            val data =
                try {
                    downloadUrl.readBytes()
                } catch (e: Exception) {
                    Log.d("HotUpdater", "Failed to download data from URL: $zipUrl")
                    return false
                }

            val file = File(path)
            try {
                file.parentFile?.mkdirs()
                file.writeBytes(data)
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to save data: ${e.message}")
                return false
            }

            val extractedPath = file.parentFile?.path
            if (extractedPath == null) {
                return false
            }

            if (!extractZipFileAtPath(path, extractedPath)) {
                Log.d("HotUpdater", "Failed to extract zip file.")
                return false
            }

            val extractedDirectory = File(extractedPath)
            val indexFile = extractedDirectory.walk().find { it.name == "index.android.bundle" }

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
