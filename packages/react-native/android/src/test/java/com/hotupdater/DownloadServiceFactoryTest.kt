package com.hotupdater

import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URL

class DownloadServiceFactoryTest {

    @After
    fun tearDown() {
        HotUpdaterImpl.downloadServiceFactory = null
    }

    @Test
    fun `custom factory is used when set`() {
        var factoryCalled = false

        HotUpdaterImpl.downloadServiceFactory = {
            factoryCalled = true
            object : DownloadService {
                override suspend fun downloadFile(
                    fileUrl: URL,
                    destination: File,
                    fileSizeCallback: ((Long) -> Unit)?,
                    progressCallback: (Double) -> Unit,
                ): DownloadResult {
                    return DownloadResult.Success(destination)
                }
            }
        }

        val service = HotUpdaterImpl.downloadServiceFactory?.invoke()
        assertTrue("Factory should have been called", factoryCalled)
        assertNotNull("Service should not be null", service)
    }

    @Test
    fun `default factory is null`() {
        HotUpdaterImpl.downloadServiceFactory = null
        assertNull(HotUpdaterImpl.downloadServiceFactory)
    }

    @Test
    fun `OkHttpDownloadService conforms to DownloadService interface`() {
        val service: DownloadService = OkHttpDownloadService()
        assertTrue(service is OkHttpDownloadService)
    }
}
