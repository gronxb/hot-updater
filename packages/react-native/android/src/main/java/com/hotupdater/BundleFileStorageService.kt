package com.hotupdater

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URL

/**
 * Interface for bundle storage operations
 */
interface BundleStorageService {
    /**
     * Sets the current bundle URL
     * @param localPath Path to the bundle file (or null to reset)
     * @return true if the operation was successful
     */
    fun setBundleURL(localPath: String?): Boolean

    /**
     * Gets the URL to the cached bundle file
     * @return The path to the cached bundle or null if not found
     */
    fun getCachedBundleURL(): String?

    /**
     * Gets the URL to the fallback bundle included in the app
     * @return The fallback bundle path
     */
    fun getFallbackBundleURL(): String

    /**
     * Gets the URL to the bundle file (cached or fallback)
     * @return The path to the bundle file
     */
    fun getBundleURL(): String

    /**
     * Updates the bundle from the specified URL
     * @param bundleId ID of the bundle to update
     * @param fileUrl URL of the bundle file to download (or null to reset)
     * @param progressCallback Callback for download progress updates
     * @return true if the update was successful
     */
    suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        progressCallback: (Double) -> Unit,
    ): Boolean
}

/**
 * Implementation of BundleStorageService
 */
class BundleFileStorageService(
    private val fileSystem: FileSystemService,
    private val downloadService: DownloadService,
    private val unzipService: UnzipService,
    private val preferences: PreferencesService,
) : BundleStorageService {
    override fun setBundleURL(localPath: String?): Boolean {
        preferences.setItem("HotUpdaterBundleURL", localPath)
        return true
    }

    override fun getCachedBundleURL(): String? {
        val urlString = preferences.getItem("HotUpdaterBundleURL")
        if (urlString.isNullOrEmpty()) {
            return null
        }

        val file = File(urlString)
        if (!file.exists()) {
            preferences.setItem("HotUpdaterBundleURL", null)
            return null
        }
        return urlString
    }

    override fun getFallbackBundleURL(): String = "assets://index.android.bundle"

    override fun getBundleURL(): String = getCachedBundleURL() ?: getFallbackBundleURL()

    override suspend fun updateBundle(
        bundleId: String,
        fileUrl: String?,
        progressCallback: (Double) -> Unit,
    ): Boolean {
        Log.d("BundleStorage", "updateBundle bundleId $bundleId fileUrl $fileUrl")

        if (fileUrl.isNullOrEmpty()) {
            setBundleURL(null)
            return true
        }

        val baseDir = fileSystem.getExternalFilesDir()
        val bundleStoreDir = File(baseDir, "bundle-store")
        if (!bundleStoreDir.exists()) {
            bundleStoreDir.mkdirs()
        }

        val finalBundleDir = File(bundleStoreDir, bundleId)
        if (finalBundleDir.exists()) {
            Log.d("BundleStorage", "Bundle for bundleId $bundleId already exists. Using cached bundle.")
            val existingIndexFile = finalBundleDir.walk().find { it.name == "index.android.bundle" }
            if (existingIndexFile != null) {
                finalBundleDir.setLastModified(System.currentTimeMillis())
                setBundleURL(existingIndexFile.absolutePath)
                cleanupOldBundles(bundleStoreDir)
                return true
            } else {
                finalBundleDir.deleteRecursively()
            }
        }

        val tempDir = File(baseDir, "bundle-temp")
        if (tempDir.exists()) {
            tempDir.deleteRecursively()
        }
        tempDir.mkdirs()

        val tempZipFile = File(tempDir, "bundle.zip")

        return withContext(Dispatchers.IO) {
            val downloadUrl = URL(fileUrl)

            // Download the file
            val downloadResult =
                downloadService.downloadFile(
                    downloadUrl,
                    tempZipFile,
                    progressCallback,
                )

            when (downloadResult) {
                is DownloadResult.Error -> {
                    Log.d("BundleStorage", "Download failed: ${downloadResult.exception.message}")
                    tempDir.deleteRecursively()
                    return@withContext false
                }
                is DownloadResult.Success -> {
                    // 1) .tmp 디렉토리 생성 (기존 <bundleId> 폴더와 겹치지 않도록 .tmp 붙임)
                    val tmpDir = File(bundleStoreDir, "$bundleId.tmp")
                    if (tmpDir.exists()) {
                        tmpDir.deleteRecursively()
                    }
                    tmpDir.mkdirs()

                    // 2) tmpDir에 압축 풀기
                    Log.d("BundleStorage", "Unzipping $tempZipFile → $tmpDir")
                    if (!unzipService.extractZipFile(tempZipFile.absolutePath, tmpDir.absolutePath)) {
                        Log.d("BundleStorage", "Failed to extract zip into tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        return@withContext false
                    }

                    // 3) tmpDir 내부에 index.android.bundle 찾기
                    val extractedIndex = tmpDir.walk().find { it.name == "index.android.bundle" }
                    if (extractedIndex == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in tmpDir.")
                        tempDir.deleteRecursively()
                        tmpDir.deleteRecursively()
                        return@withContext false
                    }

                    // 4) realDir(=bundle-store/<bundleId>)가 있으면 삭제
                    if (finalBundleDir.exists()) {
                        finalBundleDir.deleteRecursively()
                    }

                    // 5) tmpDir → realDir 로 rename 시도 (같은 부모 폴더이므로 원자적 처리)
                    val renamed = tmpDir.renameTo(finalBundleDir)
                    if (!renamed) {
                        // rename 실패 시, moveItem 혹은 copyItem으로 대체
                        if (!fileSystem.moveItem(tmpDir.absolutePath, finalBundleDir.absolutePath)) {
                            fileSystem.copyItem(tmpDir.absolutePath, finalBundleDir.absolutePath)
                            tmpDir.deleteRecursively()
                        }
                    }

                    // 6) realDir 내부에 index.android.bundle 존재 확인
                    val finalIndexFile2 = finalBundleDir.walk().find { it.name == "index.android.bundle" }
                    if (finalIndexFile2 == null) {
                        Log.d("BundleStorage", "index.android.bundle not found in realDir.")
                        tempDir.deleteRecursively()
                        finalBundleDir.deleteRecursively()
                        return@withContext false
                    }

                    // 7) realDir의 수정 시간 갱신
                    finalBundleDir.setLastModified(System.currentTimeMillis())

                    // 8) Preferences에 새 번들 경로 저장
                    val bundlePath2 = finalIndexFile2.absolutePath
                    Log.d("BundleStorage", "Setting bundle URL: $bundlePath2")
                    setBundleURL(bundlePath2)

                    // 9) 임시 및 다운로드 폴더 정리
                    tempDir.deleteRecursively()

                    // 10) 오래된 번들 정리
                    cleanupOldBundles(bundleStoreDir)

                    Log.d("BundleStorage", "Downloaded and activated bundle successfully.")
                    return@withContext true
                }
            }
        }
    }

    private fun cleanupOldBundles(bundleStoreDir: File) {
        val bundles = bundleStoreDir.listFiles { file -> file.isDirectory && !file.name.endsWith(".tmp") }?.toList() ?: return
        val sortedBundles = bundles.sortedByDescending { it.lastModified() }
        if (sortedBundles.size > 1) {
            sortedBundles.drop(1).forEach { oldBundle ->
                Log.d("BundleStorage", "Removing old bundle: ${oldBundle.name}")
                oldBundle.deleteRecursively()
            }
        }

        // .tmp 폴더 중 남아있는 것이 있으면 제거
        bundleStoreDir.listFiles { file -> file.isDirectory && file.name.endsWith(".tmp") }?.forEach { staleTmp ->
            Log.d("BundleStorage", "Removing stale tmp directory: ${staleTmp.name}")
            staleTmp.deleteRecursively()
        }
    }
}
