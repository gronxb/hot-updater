package com.hotupdater

import android.content.Context
import android.util.Log
import java.io.File
import java.net.MalformedURLException
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore

class HotUpdater internal constructor(context: Context) {
    private val mContext: Context = context
    private var bundleURL: String? = null

    companion object {
        private var mCurrentInstance: HotUpdater? = null

        fun initialize(context: Context): HotUpdater {
            Log.d("HotUpdater", "Initializing HotUpdater")
            return mCurrentInstance
                    ?: synchronized(this) {
                        mCurrentInstance ?: HotUpdater(context).also { mCurrentInstance = it }
                    }
        }

        fun getJSBundleFile(): String? {
            return mCurrentInstance?.getBundleURL()
        }

        fun getBundleVersion(): String? {
            return mCurrentInstance?.getBundleVersion()
        }

        fun updateBundle(prefix: String, urls: List<String>): Boolean? {
            Log.d("HotUpdater", "Updating bundle with prefix: $prefix")
            urls.forEach { Log.d("HotUpdater", it.toString()) }

            return mCurrentInstance?.updateBundle(prefix, urls)
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

    fun getBundleURL(): String? {
        if (bundleURL == null) {
            val sharedPreferences =
                    mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
            val urlString = sharedPreferences.getString("HotUpdaterBundleURL", null)
            return urlString
        }
        return bundleURL
    }

    private fun setBundleURL(_bundleURL: String) {
        synchronized(this) {
            if (bundleURL == null) {
                bundleURL = _bundleURL
                val sharedPreferences =
                        mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
                with(sharedPreferences.edit()) {
                    putString("HotUpdaterBundleURL", bundleURL)
                    apply()
                }
            }
        }
    }
    private fun setBundleVersion(bundleVersion: String) {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
        with(sharedPreferences.edit()) {
            putString("HotUpdaterBundleVersion", bundleVersion)
            apply()
        }
    }

    fun getBundleVersion(): String? {
        val sharedPreferences =
                mContext.getSharedPreferences("HotUpdaterPrefs", Context.MODE_PRIVATE)
        return sharedPreferences.getString("HotUpdaterBundleVersion", null)
    }

    fun updateBundle(prefix: String, urls: List<String>): Boolean {
        val executor = Executors.newFixedThreadPool(urls.size)
        val semaphore = Semaphore(0)

        var allSuccess = true

        for (urlString in urls) {
            executor.execute {
                try {
                    val url = URL(urlString)
                    val filename = url.path.substring(url.path.lastIndexOf('/') + 1)
                    val basePath = stripPrefixFromPath(prefix, url.path)
                    val path = convertFileSystemPathFromBasePath(basePath)

                    try {
                        val data = url.readBytes()

                        val file = File(path)
                        file.parentFile?.mkdirs()
                        file.writeBytes(data)

                        if (filename.startsWith("index") && filename.endsWith(".bundle")) {
                            setBundleURL(path)
                        }
                    } catch (e: Exception) {
                        Log.d("HotUpdater", "Failed to download data from URL: $url")
                        Log.d("HotUpdater", e.toString())
                        allSuccess = false
                    } finally {
                        semaphore.release()
                    }
                } catch (e: MalformedURLException) {
                    Log.d("HotUpdater", "Invalid URL: $urlString")
                    allSuccess = false
                    semaphore.release()
                }
            }
        }

        for (i in urls.indices) {
            semaphore.acquire()
        }

        executor.shutdown()

        if (allSuccess) {
            setBundleVersion(prefix)
            Log.d("HotUpdater", "Downloaded all files.")
        }
        return allSuccess
    }
}
