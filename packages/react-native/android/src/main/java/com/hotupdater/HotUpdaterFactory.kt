package com.hotupdater

import android.content.Context

/**
 * Factory for creating HotUpdaterImpl instances with proper dependency injection
 */
object HotUpdaterFactory {
    @Volatile
    private var instance: HotUpdaterImpl? = null

    /**
     * Gets the singleton instance of HotUpdaterImpl
     * @param context Application context
     * @return HotUpdaterImpl instance
     */
    fun getInstance(context: Context): HotUpdaterImpl =
        instance ?: synchronized(this) {
            instance ?: createHotUpdaterImpl(context).also { instance = it }
        }

    /**
     * Creates a new HotUpdaterImpl instance with all dependencies
     * @param context Application context
     * @return New HotUpdaterImpl instance
     */
    private fun createHotUpdaterImpl(context: Context): HotUpdaterImpl {
        val appContext = context.applicationContext
        val appVersion = HotUpdaterImpl.getAppVersion(appContext) ?: "unknown"

        // Create services
        val fileSystem = FileManagerService(appContext)
        val preferences = VersionedPreferencesService(appContext, appVersion)
        val downloadService = HttpDownloadService()
        val unzipService = ZipFileUnzipService()

        // Create bundle storage with dependencies
        val bundleStorage =
            BundleFileStorageService(
                fileSystem,
                downloadService,
                unzipService,
                preferences,
            )

        // Create and return the implementation
        return HotUpdaterImpl(appContext, bundleStorage, preferences)
    }
}
