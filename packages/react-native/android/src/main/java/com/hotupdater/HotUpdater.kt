package com.hotupdater

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.ReactInstanceManager
import com.facebook.react.ReactNativeHost
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.LifecycleEventListener
import java.io.File
import java.lang.reflect.Field
import java.net.URL
import java.util.zip.ZipFile

class HotUpdater internal constructor(context: Context, reactNativeHost: ReactNativeHost) {
    private val mContext: Context = context
    private val mReactNativeHost: ReactNativeHost = reactNativeHost

    companion object {
        private var mCurrentInstance: HotUpdater? = null

        fun init(context: Context, reactNativeHost: ReactNativeHost): HotUpdater {
            Log.d("HotUpdater", "Initializing HotUpdater")

            return mCurrentInstance
                    ?: synchronized(this) {
                        mCurrentInstance
                                ?: HotUpdater(context, reactNativeHost).also {
                                    mCurrentInstance = it
                                }
                    }
        }

        fun getAppVersion(): String? {
            return mCurrentInstance?.getAppVersion()
        }

        fun initializeOnAppUpdate() {
            mCurrentInstance?.initializeOnAppUpdate()
        }

        fun reload() {
            mCurrentInstance?.reload()
        }

        fun getJSBundleFile(): String? {
            Log.d("HotUpdater", "Getting JS bundle file ${mCurrentInstance?.getBundleURL()}")
            return mCurrentInstance?.getBundleURL()
        }

        fun getBundleTimestamp(): Double? {
            return mCurrentInstance?.getBundleTimestamp()
        }

        fun updateBundle(prefix: String, url: String?): Boolean? {
            return mCurrentInstance?.updateBundle(prefix, url)
        }
    }

    private val documentsDir: String
        get() = mContext.getExternalFilesDir(null)?.absolutePath ?: mContext.filesDir.absolutePath

    private fun convertFileSystemPathFromBasePath(basePath: String): String {
        val separator = if (basePath.startsWith("/")) "" else "/"
        return "$documentsDir$separator$basePath"
    }

    private fun stripPrefixFromPath(prefix: String, path: String): String {
        return if (path.startsWith("/$prefix/")) {
            path.replaceFirst("/$prefix/", "")
        } else {
            path
        }
    }

    private fun loadBundleLegacy() {
        val currentActivity: Activity? =
                mReactNativeHost.reactInstanceManager.currentReactContext?.currentActivity
        if (currentActivity == null) {
            return
        }

        currentActivity.runOnUiThread { currentActivity.recreate() }
    }
    private var mLifecycleEventListener: LifecycleEventListener? = null

    private fun clearLifecycleEventListener() {
        if (mLifecycleEventListener != null) {
            mReactNativeHost.reactInstanceManager.currentReactContext?.removeLifecycleEventListener(
                    mLifecycleEventListener
            )
            mLifecycleEventListener = null
        }
    }

    private fun setJSBundle(instanceManager: ReactInstanceManager, latestJSBundleFile: String?) {

        try {
            var latestJSBundleLoader: JSBundleLoader? = null

            if (latestJSBundleFile != null && latestJSBundleFile.lowercase().startsWith("assets://")
            ) {
                latestJSBundleLoader =
                        JSBundleLoader.createAssetLoader(
                                instanceManager.currentReactContext,
                                latestJSBundleFile,
                                false
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
            throw IllegalAccessException("Could not setJSBundle")
        }
    }

    fun initializeOnAppUpdate() {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)

        val currentVersion = getAppVersion()
        val savedVersion = sharedPreferences.getString("HotUpdaterAppVersion", null)

        if (currentVersion != savedVersion) {
            val editor = sharedPreferences.edit()
            editor.remove("HotUpdaterBundleURL")
            editor.remove("HotUpdaterBundleVersion")
            editor.putString("HotUpdaterAppVersion", currentVersion)
            editor.apply()
        }
    }

    fun reload() {
        Log.d("HotUpdater", "HotUpdater requested a reload ${getBundleURL()}")

        setJSBundle(mReactNativeHost.reactInstanceManager, getBundleURL())

        clearLifecycleEventListener()
        try {
            Handler(Looper.getMainLooper()).post {
                try {
                    mReactNativeHost.reactInstanceManager.recreateReactContextInBackground()
                } catch (t: Throwable) {
                    loadBundleLegacy()
                }
            }
        } catch (t: Throwable) {
            loadBundleLegacy()
        }
    }

    fun getAppVersion(): String {
        val packageInfo = mContext.packageManager.getPackageInfo(mContext.packageName, 0)
        return packageInfo.versionName
    }

    fun getBundleURL(): String {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
        val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
        if (urlString.isNullOrEmpty()) {
            return "assets://index.android.bundle"
        }

        return urlString
    }

    private fun setBundleURL(bundleURL: String?) {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
        with(sharedPreferences.edit()) {
            putString("HotUpdaterBundleURL", bundleURL)
            apply()
        }
    }
    private fun setBundleTimestamp(bundleTimestamp: String?) {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
        with(sharedPreferences.edit()) {
            putString("HotUpdaterBundleVersion", bundleTimestamp)
            apply()
        }
    }

    fun getBundleTimestamp(): Double? {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
        val bundleTimestamp = sharedPreferences.getString("HotUpdaterBundleVersion", null)
        Log.d("HotUpdater", "Bundle version: $bundleTimestamp")
        return if (bundleTimestamp != null && bundleTimestamp.isNotEmpty()) {
            try {
                bundleTimestamp.toDouble()
            } catch (e: Exception) {
                -1.0
            }
        } else {
            -1.0
        }
    }

    private fun extractZipFileAtPath(filePath: String, destinationPath: String): Boolean {
        return try {
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
    }

    fun updateBundle(prefix: String, url: String?): Boolean {
        if (url == null) {
            setBundleURL(null)
            setBundleTimestamp(null)
            return true
        }

        val downloadUrl = URL(url)

        val basePath = stripPrefixFromPath(prefix, downloadUrl.path)
        val path = convertFileSystemPathFromBasePath(basePath)

        val data =
                try {
                    downloadUrl.readBytes()
                } catch (e: Exception) {
                    Log.d("HotUpdater", "Failed to download data from URL: $url")
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
            setBundleURL(bundlePath)
        } else {
            Log.d("HotUpdater", "index.android.bundle not found.")
            return false
        }

        setBundleTimestamp(prefix)
        Log.d("HotUpdater", "Downloaded and extracted file successfully.")

        return true
    }
}
