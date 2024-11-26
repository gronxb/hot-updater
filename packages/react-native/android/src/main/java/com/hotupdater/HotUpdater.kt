package com.hotupdater

import android.annotation.SuppressLint
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
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager
import java.io.File
import java.lang.reflect.Field
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipFile

class HotUpdater(
    private val context: Context,
) : ReactPackage {
    private val mContext: Context = context

    init {
        synchronized(this) {
            if (mCurrentInstance == null) {
                mCurrentInstance = this
            }
        }
    }

    override fun createViewManagers(context: ReactApplicationContext): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    override fun createNativeModules(context: ReactApplicationContext): MutableList<NativeModule> =
        listOf(HotUpdaterModule(context)).toMutableList()

    companion object {
        @SuppressLint("StaticFieldLeak")
        @Volatile
        private var mCurrentInstance: HotUpdater? = null

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

        private fun getJSBundlerLoader(
            context: Context,
            bundleFileUrl: String,
        ): JSBundleLoader? {
            var bundleLoader: JSBundleLoader?

            if (bundleFileUrl.lowercase().startsWith("assets://")) {
                bundleLoader =
                    JSBundleLoader.createAssetLoader(
                        context,
                        bundleFileUrl,
                        true,
                    )
            } else {
                bundleLoader = JSBundleLoader.createFileLoader(bundleFileUrl)
            }
            return bundleLoader
        }

        private fun setJSBundleOldArch(
            context: Context,
            instanceManager: ReactInstanceManager,
            bundleURL: String,
        ) {
            try {
                val bundleLoader: JSBundleLoader? = this.getJSBundlerLoader(context, bundleURL)
                val bundleLoaderField: Field =
                    instanceManager::class.java.getDeclaredField("mBundleLoader")
                bundleLoaderField.isAccessible = true

                if (bundleLoader != null) {
                    bundleLoaderField.set(instanceManager, bundleLoader)
                } else {
                    bundleLoaderField.set(instanceManager, null)
                }
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
                throw IllegalAccessException("Could not setJSBundle")
            }
        }

        private fun setJSBundleNewArch(
            context: Context,
            reactHost: ReactHost,
            bundleURL: String,
        ) {
            try {
                val reactHostDelegateField = reactHost::class.java.getDeclaredField("mReactHostDelegate")
                reactHostDelegateField.isAccessible = true
                val reactHostDelegate =
                    reactHostDelegateField.get(
                        reactHost,
                    )
                val jsBundleLoaderField = reactHostDelegate::class.java.getDeclaredField("jsBundleLoader")
                jsBundleLoaderField.isAccessible = true
                jsBundleLoaderField.set(reactHostDelegate, getJSBundlerLoader(context, bundleURL))
            } catch (e: Exception) {
                Log.d("HotUpdater", "Failed to setJSBundle: ${e.message}")
                throw IllegalAccessException("Could not setJSBundle")
            }
        }

        private fun getReactApplication(application: Application?): ReactApplication {
            if (application is ReactApplication) {
                return application
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
            val reactApplication: ReactApplication = this.getReactApplication(activity?.application)
            val reactHost: ReactHost? = reactApplication.reactHost
            val reactNativeHost: ReactNativeHost = reactApplication.reactNativeHost
            val bundleURL = getBundleURL(context)

            if (!BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
                setJSBundleOldArch(context, reactNativeHost.reactInstanceManager, bundleURL)
            } else if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED && reactHost != null) {
                setJSBundleNewArch(context, reactHost, bundleURL)
            }

            Handler(Looper.getMainLooper()).post {
                reactApplication.restart(activity, "HotUpdater requested a reload")
            }
        }

        public fun getJSBundleFile(): String {
            val context = mCurrentInstance?.mContext ?: return "assets://index.android.bundle"

            val sharedPreferences =
                context.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
            if (urlString.isNullOrEmpty()) {
                return "assets://index.android.bundle"
            }

            return urlString
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

            val extractedPath = File(path).parentFile?.path ?: return false

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
