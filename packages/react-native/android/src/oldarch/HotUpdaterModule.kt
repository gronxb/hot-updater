package com.hotupdater

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.hotupdater.source.file.DefaultFileDataSource
import com.hotupdater.source.file.FileDataSource
import com.hotupdater.source.preferences.DefaultPreferencesSource
import com.hotupdater.source.preferences.PreferencesSource
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class HotUpdaterModule internal constructor(
    private val fileDataSource: FileDataSource = DefaultFileDataSource(),
    private val preferencesSource: PreferencesSource = DefaultPreferencesSource(),
    context: ReactApplicationContext,
) : HotUpdaterSpec(context) {
    private val reactIntegrationManager: ReactIntegrationManager = ReactIntegrationManager(context)
    private val reactApplicationContext: ReactApplicationContext = context

    override fun getName(): String = NAME

    @ReactMethod
    override fun reload() {
        val activity = (reactApplicationContext as? ReactApplicationContext)?.currentActivity
        val reactApplication = reactIntegrationManager.getReactApplication(activity?.application)
        val bundleURL = preferencesSource.getBundleURL(reactApplicationContext) ?: "assets://index.android.bundle"

        reactIntegrationManager.setJSBundle(
            reactApplication,
            bundleURL,
        )
        UiThreadUtil.runOnUiThread {
            reactIntegrationManager.reload(reactApplication)
        }
    }

    @ReactMethod
    override fun getAppVersion(promise: Promise) {
        val versionName =
            runCatching {
                val packageInfo =
                    reactApplicationContext.packageManager.getPackageInfo(
                        reactApplicationContext.packageName,
                        0,
                    )
                packageInfo.versionName
            }.getOrNull()
        promise.resolve(versionName)
    }

    @ReactMethod
    override fun updateBundle(
        bundleId: String,
        zipUrl: String,
        promise: Promise,
    ) {
        if (zipUrl.isEmpty()) {
            preferencesSource.setBundleURL(
                reactApplicationContext,
                null,
            )
            promise.resolve(true)
            return
        }

        val downloadUrl = URL(zipUrl)
        val basePath =
            fileDataSource.stripPrefix(
                bundleId,
                downloadUrl.path,
            )
        val path =
            fileDataSource.convertFileSystemPath(
                reactApplicationContext,
                basePath,
            )

        var connection: HttpURLConnection? = null
        try {
            connection = downloadUrl.openConnection() as HttpURLConnection
            connection.connect()

            val totalSize = connection.contentLength
            if (totalSize <= 0) {
                promise.resolve(false)
                return
            }
            val file = File(path)
            file.parentFile?.mkdirs()

            connection.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(8 * 1024)
                    var bytesRead: Int
                    var totalRead = 0L

                    while (input.read(buffer).also { bytesRead = it } != -1) {
                        output.write(
                            buffer,
                            0,
                            bytesRead,
                        )
                        totalRead += bytesRead
                        val progress = (totalRead.toDouble() / totalSize)
                        val params =
                            WritableNativeMap().apply {
                                putDouble(
                                    "progress",
                                    progress,
                                )
                            }

                        this.reactApplicationContext
                            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                            .emit(
                                "onProgress",
                                params,
                            )
                    }
                }
            }
        } catch (e: Exception) {
            promise.resolve(false)
            return
        } finally {
            connection?.disconnect()
        }

        val extractedPath =
            File(path).parentFile?.path ?: run {
                promise.resolve(false)
                return
            }
        if (!fileDataSource.extractZipFileAtPath(
                path,
                extractedPath,
            )
        ) {
            promise.resolve(false)
            return
        }

        val extractedDirectory = File(extractedPath)
        val indexFile = extractedDirectory.walk().find { it.name == "index.android.bundle" }
        if (indexFile != null) {
            preferencesSource.setBundleURL(
                reactApplicationContext,
                indexFile.path,
            )
        } else {
            promise.resolve(false)
            return
        }
        promise.resolve(true)
    }

    companion object {
        const val NAME = "HotUpdaterModule"
    }
}
