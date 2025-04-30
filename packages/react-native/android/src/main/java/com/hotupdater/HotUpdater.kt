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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipFile

class HotUpdater : ReactPackage {
    // W Fix 1: Change parameter name 'context' to 'reactContext'
    override fun createViewManagers(reactContext: ReactApplicationContext): MutableList<ViewManager<View, ReactShadowNode<*>>> = mutableListOf()

    // W Fix 2: Change parameter name 'context' to 'reactContext'
    override fun createNativeModules(reactContext: ReactApplicationContext): MutableList<NativeModule> =
        listOf(HotUpdaterModule(reactContext)).toMutableList() // Pass reactContext here too

    companion object {
        // E Fix 8: Change visibility from private to internal for test access
        internal const val PREF_KEY_BUNDLE_URL = "HotUpdaterBundleURL"
        internal const val PREF_KEY_PREV_BUNDLE_URL = "HotUpdaterPrevBundleURL"
        internal const val PREF_KEY_PROVISIONAL = "HotUpdaterProvisional"
        internal const val PREF_KEY_FIRST_RUN = "HotUpdaterFirstRun"

        // getAppVersion, prefsInstance, cachedAppVersion, getPrefs는 변경 없음
        fun getAppVersion(context: Context): String? {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            return packageInfo.versionName
        }

        @Volatile
        private var prefsInstance: HotUpdaterPrefs? = null

        @Volatile
        private var cachedAppVersion: String? = null

        private fun getPrefs(context: Context): HotUpdaterPrefs {
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

        // E Fix 5: Change visibility from private to internal for test access
        internal fun setBundleURL(
            context: Context,
            bundleURL: String?,
        ) {
            val prefs = getPrefs(context)
            prefs.setItem(PREF_KEY_BUNDLE_URL, bundleURL)
            if (bundleURL == null) return

            // ReactIntegrationManager 관련 로직은 테스트에서 직접 호출하지 않으므로 그대로 둠
            try {
                // Assuming ReactIntegrationManager exists and is relevant
                val reactIntegrationManager = ReactIntegrationManager(context)
                val activity: Activity? = getCurrentActivity(context)
                if (activity?.application != null) {
                   val reactApplication: ReactApplication = reactIntegrationManager.getReactApplication(activity.application)
                   reactIntegrationManager.setJSBundle(reactApplication, bundleURL)
                } else {
                    Log.w("HotUpdater", "Could not get ReactApplication in setBundleURL")
                }
                 Log.d("HotUpdater", "(Skipped in non-test) Set bundle URL via ReactIntegrationManager for: $bundleURL")
            } catch (e: Exception) {
                 Log.e("HotUpdater", "Error setting JS bundle in ReactIntegrationManager: ${e.message}", e)
            }
        }

        fun notifyAppReady(context: Context) {
            val prefs = getPrefs(context)
            val isProvisional = prefs.getItem(PREF_KEY_PROVISIONAL) == "true"

            if (isProvisional) {
                prefs.removeItem(PREF_KEY_PROVISIONAL)
                prefs.removeItem(PREF_KEY_PREV_BUNDLE_URL) // 성공 시 이전 번들 백업 제거
                prefs.removeItem(PREF_KEY_FIRST_RUN) // First run 플래그도 제거
                Log.d("HotUpdater", "New bundle confirmed as stable.")
            } else {
                Log.d("HotUpdater", "No provisional bundle found to confirm.")
            }
        }

        fun getJSBundleFile(context: Context): String {
            val prefs = getPrefs(context)
            val isProvisional = prefs.getItem(PREF_KEY_PROVISIONAL) == "true"
            val isFirstRun = prefs.getItem(PREF_KEY_FIRST_RUN) == "true"
            val currentBundleUrl = prefs.getItem(PREF_KEY_BUNDLE_URL)
            val prevBundleUrl = prefs.getItem(PREF_KEY_PREV_BUNDLE_URL)

            if (isProvisional) {
                if (isFirstRun) {
                    // 첫 실행: provisional 번들 반환, First Run 플래그 제거
                    Log.d("HotUpdater", "First run with provisional bundle. Marking as not first run.")
                    prefs.removeItem(PREF_KEY_FIRST_RUN)
                    currentBundleUrl?.let { bundle ->
                        if (File(bundle).exists()) {
                            Log.d("HotUpdater", "Returning first-run provisional bundle: $bundle")
                            return bundle
                        } else {
                             Log.w("HotUpdater", "Provisional bundle file does not exist: $bundle. Falling back.")
                             // Provisional이지만 파일이 없으면 롤백 로직으로 처리
                        }
                    }
                }
                // else는 두 번째 이후 실행 (롤백 시도) 또는 첫 실행인데 파일 없는 경우
                Log.d("HotUpdater", "Provisional bundle found, but not first run or file missing. Attempting rollback.")
                // 이전 안정 번들로 롤백 시도
                prevBundleUrl?.let { prev ->
                    if (File(prev).exists()) {
                        Log.d("HotUpdater", "Rollback to previous bundle: $prev")
                        // *** 수정: 롤백 시 상태 업데이트 ***
                        prefs.setItem(PREF_KEY_BUNDLE_URL, prev) // 메인 번들 URL을 롤백된 번들로 설정
                        prefs.removeItem(PREF_KEY_PROVISIONAL)
                        prefs.removeItem(PREF_KEY_PREV_BUNDLE_URL) // 사용된 이전 번들 URL 제거
                        prefs.removeItem(PREF_KEY_FIRST_RUN) // First Run 플래그도 확실히 제거
                        return prev
                    } else {
                         Log.w("HotUpdater", "Previous bundle file for rollback does not exist: $prev")
                    }
                }

                // 백업 없거나 백업 파일 없으면 기본 번들로 롤백
                Log.d("HotUpdater", "No valid previous bundle found for rollback. Rolling back to default.")
                prefs.removeItem(PREF_KEY_PROVISIONAL)
                prefs.removeItem(PREF_KEY_FIRST_RUN)
                prefs.removeItem(PREF_KEY_BUNDLE_URL)
                prefs.removeItem(PREF_KEY_PREV_BUNDLE_URL)
                return "assets://index.android.bundle" // Assume default exists

            }

            // 정상 상태: Provisional 아님
            prefs.removeItem(PREF_KEY_FIRST_RUN) // 혹시 남아있을 수 있는 플래그 제거
            currentBundleUrl?.let { stable ->
                if (File(stable).exists()) {
                    Log.d("HotUpdater", "Returning stable bundle: $stable")
                    return stable
                } else {
                    Log.w("HotUpdater", "Stable bundle file not found: $stable. Falling back to default.")
                    prefs.removeItem(PREF_KEY_BUNDLE_URL) // 존재하지 않는 번들 URL 제거
                }
            }

            // 안정 번들 URL이 없거나 파일이 없는 경우 기본 번들 반환
            Log.d("HotUpdater", "No stable bundle URL found or file missing. Returning default bundle.")
            return "assets://index.android.bundle" // Assume default exists
        }

        // E Fix 4: Change visibility from private to internal for test access
         internal fun extractZipFileAtPath(
            filePath: String,
            destinationPath: String,
        ): Boolean =
            try {
                // Zip Slip 취약점 방지 추가
                val destDir = File(destinationPath)
                if (!destDir.isDirectory && !destDir.mkdirs()) {
                     throw IOException("Failed to create destination directory: $destinationPath")
                }
                val canonicalDestPath = destDir.canonicalPath

                ZipFile(filePath).use { zip ->
                    zip.entries().asSequence().forEach { entry ->
                        val file = File(destDir, entry.name)
                        val canonicalEntryPath = file.canonicalPath

                        // 경로 조작 방지: 압축 해제 경로가 destinationPath 내에 있는지 확인
                        if (!canonicalEntryPath.startsWith(canonicalDestPath + File.separator)) {
                            throw SecurityException("Zip Entry is outside of the target dir: ${entry.name}")
                        }

                        if (entry.isDirectory) {
                            if (!file.isDirectory && !file.mkdirs()) {
                                throw IOException("Failed to create directory: ${file.path}")
                            }
                        } else {
                            file.parentFile?.let { parent ->
                                if (!parent.isDirectory && !parent.mkdirs()) {
                                     throw IOException("Failed to create parent directory: ${parent.path}")
                                }
                            }
                            zip.getInputStream(entry).use { input ->
                                // E Fix 3: File.outputStream() returns FileOutputStream
                                file.outputStream().use { output -> input.copyTo(output) }
                            }
                        }
                    }
                }
                true
            } catch (e: Exception) {
                Log.e("HotUpdater", "Failed unzip: ${e.message}", e) // Log as error
                // 실패 시 생성된 파일/디렉토리 정리 시도
                File(destinationPath).deleteRecursively()
                false
            }

        private fun getCurrentActivity(context: Context): Activity? =
            if (context is ReactApplicationContext) context.currentActivity else null

        fun reload(context: Context) {
            try {
                // Assuming ReactIntegrationManager exists and is relevant
                val reactIntegrationManager = ReactIntegrationManager(context)
                val activity: Activity? = getCurrentActivity(context)
                 if (activity?.application != null) {
                    val reactApplication = reactIntegrationManager.getReactApplication(activity.application)
                    val bundleURL = getJSBundleFile(context)
                    reactIntegrationManager.setJSBundle(reactApplication, bundleURL)
                    Handler(Looper.getMainLooper()).post {
                        reactIntegrationManager.reload(reactApplication)
                    }
                 } else {
                    Log.w("HotUpdater", "Could not get ReactApplication in reload")
                 }
                 Log.d("HotUpdater", "(Skipped in non-test) Reload triggered.")
            } catch (e: Exception) {
                 Log.e("HotUpdater", "Error during reload: ${e.message}", e)
            }
        }


        fun setChannel(
            context: Context,
            channel: String,
        ) {
            val updaterPrefs = getPrefs(context)
            updaterPrefs.setItem("HotUpdaterChannel", channel)
        }

        fun getChannel(context: Context): String? {
            val updaterPrefs = getPrefs(context)
            return updaterPrefs.getItem("HotUpdaterChannel")
        }

        // updateBundle 은 변경 없음
        suspend fun updateBundle(
            context: Context,
            bundleId: String,
            zipUrl: String?,
            progressCallback: (Double) -> Unit,
        ): Boolean {
            val prefs = getPrefs(context)
            // provisional 상태가 아닐 때만 중복 방지
            val isProvisional = prefs.getItem(PREF_KEY_PROVISIONAL) == "true"
            if (!isProvisional) {
                val current = prefs.getItem(PREF_KEY_BUNDLE_URL)
                if (current?.contains(bundleId) == true) {
                    Log.d("HotUpdater", "Skipping redundant updateBundle for $bundleId. Bundle already set.")
                    // 이미 해당 번들 ID가 설정되어 있으면 성공으로 간주하고 종료
                    // 추가 검증: 파일 존재 여부 확인
                    // W Fix 3: Remove redundant 'current != null' check
                    if (File(current).exists()) {
                         return true
                    } else {
                        Log.w("HotUpdater", "Redundant update skipped, but file missing for: $current. Proceeding with download.")
                        // 파일이 없으면 업데이트 진행
                    }
                }
            } else {
                 Log.d("HotUpdater", "Currently in provisional state. Allowing update check for $bundleId")
            }

            Log.d("HotUpdater", "updateBundle bundleId $bundleId zipUrl $zipUrl")
            if (zipUrl.isNullOrEmpty()) {
                // zipUrl이 null이거나 비어있으면, 현재 번들 정보를 제거하고 기본 번들로 돌아가도록 함
                Log.d("HotUpdater", "zipUrl is null or empty. Clearing current bundle and reverting to default.")
                // W Fix 4: Remove unused 'currentStableBundle' variable
                // val currentStableBundle = prefs.getItem(PREF_KEY_BUNDLE_URL) // 현재 안정 번들 (Provisional 아닐 때)
                prefs.removeItem(PREF_KEY_PROVISIONAL)
                prefs.removeItem(PREF_KEY_FIRST_RUN)
                prefs.removeItem(PREF_KEY_BUNDLE_URL)
                prefs.removeItem(PREF_KEY_PREV_BUNDLE_URL)
                setBundleURL(context, null) // ReactIntegrationManager에도 알림 (기본 번들 사용하도록)

                 // 만약 이전에 안정적인 번들이 있었다면, 그 번들 폴더는 유지할 수 있음 (cleanup에서 관리)
                Log.d("HotUpdater", "Cleared bundle settings due to empty zipUrl.")
                return true // 번들 제거도 성공으로 간주
            }


            // 파일 시스템 경로 설정 및 디렉토리 생성
            val baseDir = context.getExternalFilesDir(null) ?: run {
                 Log.e("HotUpdater", "External storage directory not available.")
                 return false
             }
            val storeDir = File(baseDir, "bundle-store").apply { if (!exists()) mkdirs() }
            val finalDir = File(storeDir, bundleId)


            // 캐시된 번들 확인 및 사용 로직 개선
            if (finalDir.exists() && finalDir.isDirectory) {
                Log.d("HotUpdater", "Checking cached bundle directory: ${finalDir.absolutePath}")
                // E Fix 1 & 2 apply here implicitly: File.walk() returns FileTreeWalk
                finalDir.walk().find { it.name == "index.android.bundle" && it.isFile }?.let { idx ->
                    Log.d("HotUpdater", "Cached bundle index file found: ${idx.absolutePath}")
                    // 캐시된 번들을 사용할 때는 provisional 상태로 만들지 않음
                    // 바로 안정 상태로 설정
                    val currentBundle = prefs.getItem(PREF_KEY_BUNDLE_URL)
                     if (currentBundle != idx.absolutePath) {
                         prefs.setItem(PREF_KEY_PREV_BUNDLE_URL, currentBundle) // 이전 번들을 백업으로 설정
                         prefs.setItem(PREF_KEY_BUNDLE_URL, idx.absolutePath) // 새 캐시 번들을 현재 번들로
                         prefs.removeItem(PREF_KEY_PROVISIONAL) // 안정 상태임을 명시
                         prefs.removeItem(PREF_KEY_FIRST_RUN)
                         setBundleURL(context, idx.absolutePath) // React 에도 알림
                         Log.d("HotUpdater", "Using cached bundle as stable: $bundleId")
                     } else {
                        Log.d("HotUpdater", "Cached bundle is already the current bundle. No change needed.")
                     }
                     finalDir.setLastModified(System.currentTimeMillis()) // 사용 시간 갱신
                    cleanupOldBundles(storeDir) // 오래된 번들 정리
                    return true
                } ?: run {
                     Log.w("HotUpdater", "Cached directory exists but index file missing. Deleting cache: ${finalDir.absolutePath}")
                     finalDir.deleteRecursively() // 불완전한 캐시 삭제
                 }
            }


            // 임시 다운로드 및 압축 해제 디렉토리 준비
            val tempBaseDir = context.cacheDir ?: baseDir // 캐시 디렉토리 우선 사용
            val temp = File(tempBaseDir, "bundle-temp").apply {
                deleteRecursively() // 이전 작업 찌꺼기 제거
                mkdirs()
            }
            val zipFile = File(temp, "bundle.zip")
            val extracted = File(temp, "extracted").apply { mkdirs() }


            // 다운로드 및 압축 해제
            val success =
                withContext(Dispatchers.IO) {
                    var connection: HttpURLConnection? = null
                    try {
                        val url = URL(zipUrl)
                        connection = (url.openConnection() as HttpURLConnection).apply {
                            connectTimeout = 15000 // 15 seconds
                            readTimeout = 30000 // 30 seconds
                            instanceFollowRedirects = true // 리다이렉션 지원
                            connect()
                        }

                         // HTTP 상태 코드 확인
                        if (connection.responseCode !in 200..299) {
                             Log.e("HotUpdater", "Download failed: HTTP ${connection.responseCode} ${connection.responseMessage}")
                             return@withContext false
                        }


                        val total = connection.contentLengthLong // Long 타입 사용
                        if (total <= 0) {
                            Log.w("HotUpdater", "Content length is unknown or zero. Progress reporting will be inaccurate.")
                            // progressCallback(0.0) // 진행률 0으로 시작 알림 (선택 사항)
                        }

                         var downloaded = 0L
                        var lastProgressTime = System.currentTimeMillis()

                         connection.inputStream.use { inp ->
                             // E Fix 3: File.outputStream() returns FileOutputStream
                            zipFile.outputStream().use { out ->
                                val buf = ByteArray(8 * 1024)
                                var bytesRead: Int
                                while (inp.read(buf).also { bytesRead = it } != -1) {
                                    out.write(buf, 0, bytesRead)
                                    downloaded += bytesRead

                                     if (total > 0) {
                                        val currentTime = System.currentTimeMillis()
                                        // 진행률 콜백은 100ms 간격 또는 완료 시 호출
                                        if (currentTime - lastProgressTime >= 100 || downloaded == total) {
                                            progressCallback(downloaded.toDouble() / total)
                                            lastProgressTime = currentTime
                                        }
                                     }
                                }
                            }
                        }

                         if (total > 0 && downloaded != total) {
                             Log.w("HotUpdater", "Downloaded size ($downloaded) does not match content length ($total).")
                             // 여기서 실패 처리할 수도 있음
                         }
                         progressCallback(1.0) // 최종 완료 콜백


                        // 압축 해제
                        if (!extractZipFileAtPath(zipFile.absolutePath, extracted.absolutePath)) {
                            Log.e("HotUpdater", "Extraction failed for $zipFile")
                            return@withContext false
                        }

                         // 압축 해제 후 index.android.bundle 파일 확인
                         // E Fix 1 & 2 apply here implicitly: File.walk() returns FileTreeWalk
                        val indexFile = extracted.walk().find { it.name == "index.android.bundle" && it.isFile }
                         if (indexFile == null) {
                            Log.e("HotUpdater", "index.android.bundle not found in extracted files.")
                            return@withContext false
                         }

                        true // 다운로드 및 압축 해제 성공
                    } catch (e: Exception) {
                        Log.e("HotUpdater", "Download/extract error: ${e.message}", e)
                        false
                    } finally {
                        connection?.disconnect()
                        // 임시 파일 정리 (성공 여부와 관계없이)
                        zipFile.delete() // zip 파일은 항상 삭제
                    }
                }

            if (!success) {
                temp.deleteRecursively() // 실패 시 extracted 디렉토리 포함 임시 폴더 전체 삭제
                return false
            }

            // 최종 번들 디렉토리로 이동
            finalDir.deleteRecursively() // 기존 목적지 폴더가 있다면 삭제 (위 캐시 체크에서 실패한 경우 등)
            if (!extracted.renameTo(finalDir)) {
                 Log.e("HotUpdater", "Failed to move extracted bundle to final destination: $finalDir")
                 temp.deleteRecursively() // 이동 실패 시 임시 폴더 정리
                 return false
            }


            // --- 상태 업데이트 (Provisional 설정) ---
            val indexFile = File(finalDir, "index.android.bundle") // finalDir 내의 index 파일 경로
            if (!indexFile.exists()) {
                 Log.e("HotUpdater", "Index file not found after moving to final destination: ${indexFile.absolutePath}")
                 finalDir.deleteRecursively() // 잘못된 번들 삭제
                 return false
            }


            // 업데이트 직전 현재 번들 백업 (null일 수도 있음)
            val currentBundleBeforeUpdate = prefs.getItem(PREF_KEY_BUNDLE_URL)
            prefs.setItem(PREF_KEY_PREV_BUNDLE_URL, currentBundleBeforeUpdate)

             // Provisional 상태 및 First Run 플래그 설정
            prefs.setItem(PREF_KEY_PROVISIONAL, "true")
            prefs.setItem(PREF_KEY_FIRST_RUN, "true")

             // 메인 번들 URL을 새로 다운로드한 번들로 설정
            val newBundlePath = indexFile.absolutePath
            Log.d("HotUpdater", "Applying new bundle provisionally: $newBundlePath")
            prefs.setItem(PREF_KEY_BUNDLE_URL, newBundlePath) // SharedPreferences 업데이트
            setBundleURL(context, newBundlePath) // ReactIntegrationManager에 즉시 알림 (선택 사항, reload 전까지 적용 안될 수 있음)


            // 오래된 번들 정리 및 임시 파일 삭제
            cleanupOldBundles(storeDir)
            temp.deleteRecursively() // 성공적으로 이동 후 임시 폴더 삭제


            Log.d("HotUpdater", "Update completed provisionally for $bundleId. Path: $newBundlePath")
            return true
        }

        // cleanupOldBundles는 변경 없음
        fun cleanupOldBundles(storeDir: File) {
            try {
                val bundles = storeDir.listFiles()?.filter { it.isDirectory } ?: return
                // 최소 2개 이상일 때만 정리 작업 수행 (현재 사용 번들 + 이전 번들 또는 기타)
                if (bundles.size <= 1) return // 유지해야 할 번들 개수 (예: 1개만 남김)

                 val sortedBundles = bundles.sortedByDescending { it.lastModified() } // 최신순 정렬

                 // 삭제할 번들 결정 (가장 최신 1개만 남김)
                 val bundlesToDelete = sortedBundles.drop(1) // 가장 최신 번들 제외

                 if (bundlesToDelete.isNotEmpty()) {
                     Log.d("HotUpdater", "Cleaning up ${bundlesToDelete.size} old bundle(s).")
                     bundlesToDelete.forEach { bundleDir ->
                         Log.d("HotUpdater", "Deleting old bundle: ${bundleDir.name}")
                         if (!bundleDir.deleteRecursively()) {
                             Log.w("HotUpdater", "Failed to delete old bundle directory: ${bundleDir.absolutePath}")
                         }
                     }
                 }
            } catch (e: Exception) {
                 Log.e("HotUpdater", "Error during cleanupOldBundles: ${e.message}", e)
            }
        }

        // getMinBundleId는 변경 없음
         fun getMinBundleId(): String =
            try {
                 // Assume BuildConfig.BUILD_TIMESTAMP exists
                 val buildTimestampMs = com.hotupdater.BuildConfig.BUILD_TIMESTAMP // Needs actual BuildConfig access
                val bytes =
                    ByteArray(16).apply {
                        this[0] = ((buildTimestampMs shr 40) and 0xFF).toByte()
                        this[1] = ((buildTimestampMs shr 32) and 0xFF).toByte()
                        this[2] = ((buildTimestampMs shr 24) and 0xFF).toByte()
                        this[3] = ((buildTimestampMs shr 16) and 0xFF).toByte()
                        this[4] = ((buildTimestampMs shr 8) and 0xFF).toByte()
                        this[5] = (buildTimestampMs and 0xFF).toByte()
                        this[6] = 0x70.toByte() // Fixed part
                        this[7] = 0x00.toByte()
                        this[8] = 0x80.toByte()
                        this[9] = 0x00.toByte()
                        this[10] = 0x00.toByte()
                        this[11] = 0x00.toByte()
                        this[12] = 0x00.toByte()
                        this[13] = 0x00.toByte()
                        this[14] = 0x00.toByte()
                        this[15] = 0x00.toByte()
                    }
                String.format(
                    "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                    bytes[0].toInt() and 0xFF, bytes[1].toInt() and 0xFF, bytes[2].toInt() and 0xFF, bytes[3].toInt() and 0xFF,
                    bytes[4].toInt() and 0xFF, bytes[5].toInt() and 0xFF, bytes[6].toInt() and 0xFF, bytes[7].toInt() and 0xFF,
                    bytes[8].toInt() and 0xFF, bytes[9].toInt() and 0xFF, bytes[10].toInt() and 0xFF, bytes[11].toInt() and 0xFF,
                    bytes[12].toInt() and 0xFF, bytes[13].toInt() and 0xFF, bytes[14].toInt() and 0xFF, bytes[15].toInt() and 0xFF,
                )
            } catch (e: Exception) {
                 Log.e("HotUpdater", "Failed to get min bundle ID from build timestamp: ${e.message}")
                "00000000-0000-0000-0000-000000000000" // Fallback
            }
    }
}
