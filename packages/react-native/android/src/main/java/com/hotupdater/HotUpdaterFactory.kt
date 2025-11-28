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

        // Get isolation key using the utility method
        val isolationKey = HotUpdaterImpl.getIsolationKey(appContext)

        // Create services
        val fileSystem = FileManagerService(appContext)
        val preferences = VersionedPreferencesService(appContext, isolationKey)
        val downloadService = OkHttpDownloadService()
        val decompressService = DecompressService()

        // Create bundle storage with dependencies
        val bundleStorage =
            BundleFileStorageService(
                appContext,
                fileSystem,
                downloadService,
                decompressService,
                preferences,
            )

        // Create and return the implementation
        return HotUpdaterImpl(appContext, bundleStorage, preferences)
    }
}
