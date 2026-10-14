package com.hotupdater

import android.content.ContextWrapper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger

class NativeUpdateCheckerTest {
    companion object {
        private const val BASE_URL = "https://updates.example.com/api"
        private const val MIN_BUNDLE_ID = "01900000-0000-7000-8000-000000000000"
        private const val BUNDLE_A = "01910000-0000-7000-8000-00000000000a"
        private const val BUNDLE_B = "01920000-0000-7000-8000-00000000000b"
        private const val RELEASE_A = "01910000-0000-7000-8000-0000000000a1"
        private const val RELEASE_B = "01920000-0000-7000-8000-0000000000b1"
        private const val CATALOG_ID = "catalog-1"
        private val CATALOG_HASH = "sha256:" + "a".repeat(64)
        private val CHANNEL_KEY = ReleaseCatalogs.encodeChannelKey("production")
        private val SCOPE_KEY = "v1:app-version:android:$CHANNEL_KEY"
        private val CATALOG_URL = "$BASE_URL/release-catalogs/app-version/android/$CHANNEL_KEY/1.2.0"
        private val ARTIFACT_URL = "$BASE_URL/artifacts/v1/$BUNDLE_B/from/$MIN_BUNDLE_ID"
        private val OPTIONS =
            HotUpdaterCheckOptions(
                baseURL = "$BASE_URL/",
                updateStrategy = HotUpdaterUpdateStrategy.APP_VERSION,
                requestHeaders = mapOf("Authorization" to "Bearer token"),
            )
    }

    private class FakeTransport(
        var handler: suspend (UpdateCheckRequest) -> UpdateCheckResponse,
    ) : UpdateCheckTransport {
        val requests = mutableListOf<UpdateCheckRequest>()

        override suspend fun get(request: UpdateCheckRequest): UpdateCheckResponse {
            synchronized(requests) { requests.add(request) }
            return handler(request)
        }
    }

    private class FakeState : UpdateCheckState {
        var appVersionName: String? = "1.2.0"
        var launchedBundleId: String? = null
        var bundleIdSource: (() -> String?)? = null
        var launched = false
        var defaultChannelName = "production"
        var channelName = "production"
        var cohortValue = "500"
        var activeSelection: PersistedSelection? = null
        var stableSelection: PersistedSelection? = null
        var stageGate: CompletableDeferred<Unit>? = null
        var stageResult = UpdateBundleResult(BundleDelivery.PATCH, patchFallback = false)
        var stageError: Exception? = null

        /** Fails only the next staging. */
        @Volatile var nextStageError: Exception? = null
        val stageCount = AtomicInteger()
        val staged = CompletableDeferred<StageBundleRequest>()
        val stageEntered = CompletableDeferred<Unit>()
        val accepted = mutableListOf<ReleaseSelectionGuard>()
        val committed = mutableListOf<PersistedSelection>()
        val cache = mutableMapOf<String, String>()
        val storage = mutableMapOf<String, String>()

        override fun getAppVersion(): String? = appVersionName

        override fun getBundleId(): String? = bundleIdSource?.invoke() ?: launchedBundleId

        override fun hasLaunchedBundle(): Boolean = launched

        override fun getMinBundleId(): String = MIN_BUNDLE_ID

        override fun getDefaultChannel(): String = defaultChannelName

        override fun getChannel(): String = channelName

        override fun getCohort(): String = cohortValue

        override fun getFingerprintHash(): String? = null

        override fun getCrashHistory(): List<String> = emptyList()

        override fun getActiveUpdateState(): ActiveSelections = ActiveSelections(activeSelection, stableSelection)

        override fun acceptReleaseCatalog(guard: ReleaseSelectionGuard): Boolean {
            synchronized(accepted) { accepted.add(guard) }
            return true
        }

        override fun isReleaseSelectionCurrent(guard: ReleaseSelectionGuard): Boolean =
            synchronized(accepted) {
                accepted.lastOrNull() ==
                    guard
            }

        override suspend fun commitReleaseSelection(selection: PersistedSelection): Boolean {
            committed.add(selection)
            activeSelection = selection
            return true
        }

        override suspend fun updateBundle(
            request: StageBundleRequest,
            onProgress: (Double) -> Unit,
        ): UpdateBundleResult {
            stageCount.incrementAndGet()
            stageEntered.complete(Unit)
            onProgress(0.25)
            stageGate?.await()
            onProgress(0.255)
            onProgress(0.75)
            stageError?.let { throw it }
            nextStageError?.let {
                nextStageError = null
                throw it
            }
            activeSelection = request.selection
            staged.complete(request)
            return stageResult
        }

        override fun getReleaseCatalogCache(partition: String): String? = cache[partition]

        override fun setReleaseCatalogCache(
            partition: String,
            payload: String,
        ): Boolean {
            cache[partition] = payload
            return true
        }

        override fun removeReleaseCatalogCache(partition: String): Boolean {
            cache.remove(partition)
            return true
        }

        override fun getStorageItem(key: String): String? = synchronized(storage) { storage[key] }

        override fun setStorageItem(
            key: String,
            value: String?,
        ) {
            synchronized(storage) {
                if (value == null) storage.remove(key) else storage[key] = value
            }
        }

        override fun isOffline(): Boolean = false

        /** The queued lifecycle events, without the HTTP responses ([httpResponses]). */
        fun events(): List<JSONObject> = queued().filter { it.getString("name") != "onHttpResponse" }

        fun httpResponses(): List<JSONObject> =
            queued().filter { it.getString("name") == "onHttpResponse" }.map { it.getJSONObject("payload") }

        fun queued(): List<JSONObject> {
            val stored = getStorageItem(NativeUpdateEventQueue.STORAGE_KEY) ?: return emptyList()
            val array = JSONArray(stored)
            return (0 until array.length()).map { array.getJSONObject(it) }
        }
    }

    private fun release(
        releaseId: String,
        bundleId: String,
        shouldForceUpdate: Boolean = false,
        message: String? = null,
    ): JSONObject =
        JSONObject()
            .put("releaseId", releaseId)
            .put("kind", "BUNDLE")
            .put("bundleId", bundleId)
            .put("rolloutCohortCount", 1000)
            .put("targetCohorts", JSONArray())
            .put("shouldForceUpdate", shouldForceUpdate)
            .put("message", message ?: JSONObject.NULL)

    private fun catalog(
        releases: List<JSONObject>,
        generation: Long = 1,
    ): String =
        JSONObject()
            .put("schemaVersion", 1)
            .put("catalogId", CATALOG_ID)
            .put("scopeKey", SCOPE_KEY)
            .put("generation", generation)
            .put("catalogHash", CATALOG_HASH)
            .put("fallbackPolicy", "BUILTIN_IF_ACTIVE_INELIGIBLE")
            .put("releases", JSONArray(releases))
            .put("rollbackReleases", JSONArray(releases))
            .toString()

    private fun artifact(): String =
        JSONObject()
            .put("artifactProtocolVersion", 1)
            .put("manifestUrl", "https://cdn.example.com/b/manifest.json")
            .put("manifestFileHash", "sig:manifest")
            .put("archiveUrl", "https://cdn.example.com/b/bundle.tar.br")
            .put(
                "assets",
                JSONObject()
                    .put(
                        "index.android.bundle",
                        JSONObject()
                            .put("fileHash", "hash-bundle")
                            .put("file", JSONObject().put("url", "https://cdn.example.com/b/index.android.bundle").put("compression", "br"))
                            .put(
                                "patch",
                                JSONObject()
                                    .put("algorithm", "bsdiff")
                                    .put("baseBundleId", MIN_BUNDLE_ID)
                                    .put("baseFileHash", "hash-base")
                                    .put("patchFileHash", "hash-patch")
                                    .put("patchUrl", "https://cdn.example.com/b/index.android.bundle.bsdiff")
                                    .put("byteSize", 42),
                            ),
                    ).put(
                        "assets/logo.png",
                        JSONObject()
                            .put("fileHash", "hash-logo")
                            .put("file", JSONObject().put("url", "https://cdn.example.com/b/assets/logo.png")),
                    ),
            ).toString()

    private fun ok(
        body: String,
        headers: Map<String, String> = emptyMap(),
    ) = UpdateCheckResponse(200, "OK", headers, body)

    private fun routes(
        catalogBody: String,
        catalogHeaders: Map<String, String> = emptyMap(),
    ): suspend (UpdateCheckRequest) -> UpdateCheckResponse =
        { request ->
            when (request.url) {
                CATALOG_URL -> ok(catalogBody, catalogHeaders)
                ARTIFACT_URL -> ok(artifact())
                else -> UpdateCheckResponse(404, "Not Found", emptyMap(), "")
            }
        }

    private fun forcedCatalog() = catalog(listOf(release(RELEASE_B, BUNDLE_B, shouldForceUpdate = true)))

    private fun minorCatalog() = catalog(listOf(release(RELEASE_B, BUNDLE_B)))

    private fun elapsedMillis(since: Long) = (System.nanoTime() - since) / 1_000_000

    @Test
    fun `no catalog for the scope is no update, reported as unchanged`() =
        runBlocking {
            val state = FakeState()
            val transport =
                FakeTransport { UpdateCheckResponse(404, "Not Found", mapOf("X-Hot-Updater-Catalog" to " None "), "") }
            val checker = NativeUpdateChecker(state, transport)

            assertNull(checker.checkForUpdate(OPTIONS))
            assertEquals(HotUpdaterPrepareResult.UpToDate, checker.prepare(OPTIONS, 1_000, null))

            val request = transport.requests.first()
            assertEquals(CATALOG_URL, request.url)
            assertEquals("application/json", request.headers["accept"])
            assertEquals("Bearer token", request.headers["authorization"])
            assertEquals(5_000L, request.timeoutMillis)
            // As checkForUpdate.ts, each check that finds nothing reports the bundle the app keeps.
            val events = state.events()
            assertEquals(listOf("onUpdateCheck", "onUpdateCheck"), events.map { it.getString("name") })
            val payload = events.first().getJSONObject("payload")
            assertEquals("UNCHANGED", payload.getString("status"))
            assertEquals(MIN_BUNDLE_ID, payload.getString("bundleId"))
            assertTrue(payload.isNull("releaseId"))
            assertTrue(payload.isNull("previousReleaseId"))
            // Each catalog response is queued before the check it answered, as fetchUpdateResponse.ts reports it.
            assertEquals(listOf("onHttpResponse", "onUpdateCheck"), state.queued().take(2).map { it.getString("name") })
            val response = state.httpResponses().first()
            assertEquals("catalog", response.getString("resource"))
            assertEquals("production", response.getString("channel"))
            assertEquals(java.net.URL(CATALOG_URL).path, response.getString("path"))
            assertEquals(404, response.getInt("status"))
            assertFalse(response.getBoolean("bodyTruncated"))
        }

    @Test
    fun `headers that differ only in a name's case send and key the last value`() {
        val first = linkedMapOf("Authorization" to "A", "authorization" to "B")
        val second = linkedMapOf("authorization" to "B", "Authorization" to "A")

        assertEquals(mapOf("authorization" to "B"), effectiveHeaders(first))
        assertEquals(mapOf("authorization" to "A"), effectiveHeaders(second))
        assertNotEquals(effectiveHeaders(first), effectiveHeaders(second))
    }

    @Test
    fun `a 304 uses the cached catalog`() =
        runBlocking {
            val state = FakeState()
            val body = minorCatalog()
            val transport = FakeTransport(routes(body, mapOf("ETag" to "\"v1\"")))
            val checker = NativeUpdateChecker(state, transport)

            assertEquals(RELEASE_B, checker.checkForUpdate(OPTIONS)?.id)
            assertEquals("1\n\"v1\"\n$body", state.cache.values.single())

            transport.handler = { UpdateCheckResponse(304, "Not Modified", emptyMap(), "") }
            val update = checker.checkForUpdate(OPTIONS)

            assertEquals(RELEASE_B, update?.id)
            assertEquals("\"v1\"", transport.requests.last().headers["if-none-match"])
            assertNull(transport.requests.first().headers["if-none-match"])
        }

    @Test
    fun `an update stages through the native updateBundle and queues its events`() =
        runBlocking {
            val state = FakeState()
            val transport = FakeTransport(routes(catalog(listOf(release(RELEASE_B, BUNDLE_B, message = "Fixes")))))
            val checker = NativeUpdateChecker(state, transport)

            val update = checker.checkForUpdate(OPTIONS)!!
            assertEquals(RELEASE_B, update.id)
            assertEquals(RELEASE_B, update.releaseId)
            assertEquals(HotUpdaterUpdateStatus.UPDATE, update.status)
            assertFalse(update.shouldForceUpdate)
            assertEquals("Fixes", update.message)
            assertEquals(1000, update.rolloutCohortCount)
            assertEquals("INSTALL", update.transitionKind)

            val progress = mutableListOf<Double>()
            assertTrue(update.updateBundle { progress.add(it) })

            assertEquals(listOf(0.25, 0.75, 1.0), progress)
            assertEquals(ARTIFACT_URL, transport.requests.last().url)
            assertEquals(listOf("catalog", "artifact"), state.httpResponses().map { it.getString("resource") })
            assertEquals(java.net.URL(ARTIFACT_URL).path, state.httpResponses().last().getString("path"))
            val request = state.staged.await()
            assertEquals(BUNDLE_B, request.bundleId)
            assertEquals("production", request.channel)
            assertEquals("https://cdn.example.com/b/manifest.json", request.manifestUrl)
            assertEquals("sig:manifest", request.manifestFileHash)
            assertEquals("https://cdn.example.com/b/bundle.tar.br", request.archiveUrl)
            assertEquals(
                ChangedAssetDescriptor(
                    fileUrl = "https://cdn.example.com/b/index.android.bundle",
                    fileHash = "hash-bundle",
                    fileCompression = "br",
                    patch =
                        BsdiffPatchDescriptor(
                            algorithm = "bsdiff",
                            baseBundleId = MIN_BUNDLE_ID,
                            baseFileHash = "hash-base",
                            patchFileHash = "hash-patch",
                            patchUrl = "https://cdn.example.com/b/index.android.bundle.bsdiff",
                            byteSize = 42,
                        ),
                ),
                request.assets["index.android.bundle"],
            )
            assertEquals(
                ChangedAssetDescriptor(fileUrl = "https://cdn.example.com/b/assets/logo.png", fileHash = "hash-logo"),
                request.assets["assets/logo.png"],
            )
            val guard = state.accepted.single()
            assertEquals(
                PersistedSelection(
                    kind = "BUNDLE",
                    releaseId = RELEASE_B,
                    bundleId = BUNDLE_B,
                    catalogId = CATALOG_ID,
                    scopeKey = SCOPE_KEY,
                    generation = 1,
                    catalogHash = CATALOG_HASH,
                    channel = "production",
                    selectionContextHash = guard.selectionContextHash,
                ),
                request.selection,
            )

            val events = state.events()
            assertEquals(listOf("onUpdateCheck", "onBundleDownloaded"), events.map { it.getString("name") })
            events.forEach { assertTrue(it.getLong("occurredAt") > 0) }
            val available = events[0].getJSONObject("payload")
            assertEquals("UPDATE_AVAILABLE", available.getString("status"))
            assertEquals(MIN_BUNDLE_ID, available.getString("fromBundleId"))
            assertTrue(available.isNull("fromReleaseId"))
            assertEquals(BUNDLE_B, available.getString("toBundleId"))
            assertEquals(RELEASE_B, available.getString("toReleaseId"))
            assertEquals("INSTALL", available.getString("transitionKind"))
            assertEquals("UPDATE", available.getString("updateStatus"))
            assertFalse(available.getBoolean("shouldForceUpdate"))
            assertEquals("appVersion", available.getString("updateStrategy"))
            val downloaded = events[1].getJSONObject("payload")
            assertEquals("production", downloaded.getString("channel"))
            assertEquals(MIN_BUNDLE_ID, downloaded.getString("fromBundleId"))
            assertEquals(BUNDLE_B, downloaded.getString("toBundleId"))
            assertEquals(RELEASE_B, downloaded.getString("toReleaseId"))
            assertEquals("patch", downloaded.getString("delivery"))
            assertFalse(downloaded.getBoolean("patchFallback"))
        }

    @Test
    fun `before a launch the check counts the bundle the launch would pick as running`() =
        runBlocking {
            val impl = implWithStorage(FakeBundleStorageService(bundleId = null, nextLaunchBundleId = BUNDLE_A))
            val state = FakeState().apply { bundleIdSource = { HotUpdaterImplUpdateCheckState(ContextWrapper(null), impl).getBundleId() } }
            val artifactFromA = "$BASE_URL/artifacts/v1/$BUNDLE_B/from/$BUNDLE_A"
            val catalogBody = minorCatalog()
            val transport =
                FakeTransport { request ->
                    when (request.url) {
                        CATALOG_URL -> ok(catalogBody)
                        artifactFromA -> ok(artifact())
                        else -> UpdateCheckResponse(404, "Not Found", emptyMap(), "")
                    }
                }
            val checker = NativeUpdateChecker(state, transport)

            val update = checker.checkForUpdate(OPTIONS)!!
            assertTrue(update.updateBundle())

            assertEquals(artifactFromA, transport.requests.last().url)
            assertEquals(
                BUNDLE_A,
                state
                    .events()
                    .first()
                    .getJSONObject("payload")
                    .getString("fromBundleId"),
            )
            assertEquals(
                BUNDLE_A,
                state
                    .events()
                    .last()
                    .getJSONObject("payload")
                    .getString("fromBundleId"),
            )
        }

    @Test
    fun `after a launch the check counts the launched bundle as running`() =
        runBlocking {
            val impl = implWithStorage(FakeBundleStorageService(bundleId = null, nextLaunchBundleId = BUNDLE_B))
            val launched =
                LaunchSelection(
                    bundleUrl = "file:///bundle-store/$BUNDLE_A/index.android.bundle",
                    launchedBundleId = BUNDLE_A,
                    shouldRollbackOnCrash = false,
                )
            // As the launch sets them.
            setImplField(impl, "runningLaunchSelection", launched)
            setImplField(impl, "currentLaunchSelection", launched)
            val adapter = HotUpdaterImplUpdateCheckState(ContextWrapper(null), impl)
            assertTrue(adapter.hasLaunchedBundle())
            val state = FakeState().apply { bundleIdSource = { adapter.getBundleId() } }
            val transport = FakeTransport(routes(minorCatalog()))
            val checker = NativeUpdateChecker(state, transport)

            val update = checker.checkForUpdate(OPTIONS)!!

            assertEquals("INSTALL", update.transitionKind)
            assertEquals(
                BUNDLE_A,
                state
                    .events()
                    .single()
                    .getJSONObject("payload")
                    .getString("fromBundleId"),
            )
        }

    @Test
    fun `adopting the running bundle's Release commits without a download and reports it unchanged`() =
        runBlocking {
            val state =
                FakeState().apply {
                    launchedBundleId = BUNDLE_B
                    activeSelection = PersistedSelection.bareBundle(BUNDLE_B)
                    stableSelection = PersistedSelection.bareBundle(BUNDLE_B)
                }
            val transport = FakeTransport(routes(forcedCatalog()))
            val checker = NativeUpdateChecker(state, transport)

            val update = checker.checkForUpdate(OPTIONS)!!
            assertEquals("ADOPT_RELEASE", update.transitionKind)
            assertFalse(update.shouldForceUpdate)

            assertTrue(update.updateBundle())

            assertEquals(1, transport.requests.size)
            assertEquals(0, state.stageCount.get())
            val committed = state.committed.single()
            assertEquals(BUNDLE_B, committed.bundleId)
            assertEquals(RELEASE_B, committed.releaseId)
            val (available, unchanged) = state.events().map { it.getJSONObject("payload") }
            assertEquals("UPDATE_AVAILABLE", available.getString("status"))
            assertEquals("ADOPT_RELEASE", available.getString("transitionKind"))
            // As checkForUpdate.ts, the running bundle is now selected as the Release.
            assertEquals("UNCHANGED", unchanged.getString("status"))
            assertEquals(BUNDLE_B, unchanged.getString("bundleId"))
            assertEquals(RELEASE_B, unchanged.getString("releaseId"))
            assertTrue(unchanged.isNull("previousReleaseId"))
        }

    @Test
    fun `prepare is up to date when it adopts the Release of the bundle this launch runs`() =
        runBlocking {
            // The first launch after an update: the stored selection names the
            // bundle the app ran before it, so the catalog is selected again.
            val state =
                FakeState().apply {
                    launchedBundleId = BUNDLE_B
                    activeSelection = PersistedSelection.bareBundle(BUNDLE_B)
                    stableSelection = PersistedSelection.bareBundle(BUNDLE_B)
                }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))

            val result = withTimeout(5_000) { checker.prepare(OPTIONS, 5_000, null) }

            assertEquals(HotUpdaterPrepareResult.UpToDate, result)
            assertEquals(0, state.stageCount.get())
            assertEquals(RELEASE_B, state.committed.single().releaseId)
        }

    @Test
    fun `a required rollback to the built-in bundle commits and is ready before a launch`() =
        runBlocking {
            val receipt =
                PersistedSelection(
                    kind = "BUNDLE",
                    releaseId = RELEASE_B,
                    bundleId = BUNDLE_B,
                    catalogId = CATALOG_ID,
                    scopeKey = SCOPE_KEY,
                    generation = 1,
                    catalogHash = "sha256:" + "b".repeat(64),
                    channel = "production",
                    selectionContextHash = "v1:old",
                )
            val state =
                FakeState().apply {
                    launchedBundleId = BUNDLE_B
                    activeSelection = receipt
                    stableSelection = receipt
                }
            val transport = FakeTransport(routes(catalog(emptyList(), generation = 2)))
            val checker = NativeUpdateChecker(state, transport)
            // A download an earlier prepare queued, which the built-in bundle replaces.
            NativeUpdateEventQueue(state::getStorageItem, state::setStorageItem, build = {
                NativeUpdateEventQueue.buildOf(state.getAppVersion(), state.getMinBundleId(), state.getCohort())
            }).add("onBundleDownloaded", JSONObject())

            val result = checker.prepare(OPTIONS, 5_000, null)

            val update = (result as HotUpdaterPrepareResult.Ready).update
            assertEquals("USE_BUILTIN", update.transitionKind)
            assertEquals(HotUpdaterUpdateStatus.ROLLBACK, update.status)
            assertEquals(MIN_BUNDLE_ID, update.id)
            assertNull(update.releaseId)
            assertTrue(update.shouldForceUpdate)
            val committed = state.committed.single()
            assertEquals("BUILTIN", committed.kind)
            assertEquals(MIN_BUNDLE_ID, committed.bundleId)
            assertEquals(2L, committed.generation)
            val available = state.events().single().getJSONObject("payload")
            assertEquals(RELEASE_B, available.getString("fromReleaseId"))
            assertEquals("ROLLBACK", available.getString("updateStatus"))
        }

    @Test
    fun `prepare waits for a required update and reports its progress`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))
            val progress = mutableListOf<Double>()

            launch(Dispatchers.Default) {
                state.stageEntered.await()
                gate.complete(Unit)
            }
            val result = checker.prepare(OPTIONS, 10_000) { synchronized(progress) { progress.add(it) } }

            assertEquals(RELEASE_B, (result as HotUpdaterPrepareResult.Ready).update.id)
            assertTrue(state.staged.isCompleted)
            assertEquals(listOf(0.25, 0.75, 1.0), synchronized(progress) { progress.toList() })
        }

    @Test
    fun `prepare after React Native read the bundle is pending even when staged in time`() =
        runBlocking {
            val state = FakeState().apply { launched = true }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))

            val result = checker.prepare(OPTIONS, 5_000, null)

            assertEquals(RELEASE_B, (result as HotUpdaterPrepareResult.Pending).update.id)
            assertTrue(state.staged.isCompleted)
        }

    @Test
    fun `the deadline ends the wait for a required update and the download continues`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))

            val started = System.nanoTime()
            val result = checker.prepare(OPTIONS, 500, null)

            assertTrue(elapsedMillis(started) < 3_000)
            val update = (result as HotUpdaterPrepareResult.Pending).update
            assertTrue(update.shouldForceUpdate)
            assertFalse(state.staged.isCompleted)

            gate.complete(Unit)
            assertEquals(BUNDLE_B, withTimeout(5_000) { state.staged.await() }.bundleId)
        }

    @Test
    fun `prepare returns before a minor update finishes downloading`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))

            val result = withTimeout(5_000) { checker.prepare(OPTIONS, 60_000, null) }

            assertFalse((result as HotUpdaterPrepareResult.Pending).update.shouldForceUpdate)
            assertFalse(state.staged.isCompleted)
            gate.complete(Unit)
            assertEquals(BUNDLE_B, withTimeout(5_000) { state.staged.await() }.bundleId)
        }

    @Test
    fun `prepare joins a running download within its deadline and never stages it twice`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))
            val update = checker.checkForUpdate(OPTIONS)!!
            val background = async(Dispatchers.Default) { update.updateBundle() }
            state.stageEntered.await()

            val started = System.nanoTime()
            val joined = checker.prepare(OPTIONS, 200, null)

            assertTrue(elapsedMillis(started) < 2_000)
            assertSame(update, (joined as HotUpdaterPrepareResult.Pending).update)
            val joining = async(start = CoroutineStart.UNDISPATCHED) { update.updateBundle() }
            gate.complete(Unit)
            assertTrue(withTimeout(5_000) { background.await() })
            assertTrue(withTimeout(5_000) { joining.await() })
            // The update already staged, so calling it again does not download it again.
            assertTrue(update.updateBundle())
            assertEquals(1, state.stageCount.get())
        }

    @Test
    fun `an update that joined a staging is staged`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val transport = FakeTransport(routes(minorCatalog()))
            val checker = NativeUpdateChecker(state, transport)
            val first = checker.checkForUpdate(OPTIONS)!!
            val second = checker.checkForUpdate(OPTIONS)!!
            assertEquals(first.targetKey, second.targetKey)

            val staging = async(Dispatchers.Default) { first.updateBundle() }
            state.stageEntered.await()
            val joined = async(start = CoroutineStart.UNDISPATCHED) { second.updateBundle() }
            gate.complete(Unit)
            assertTrue(withTimeout(5_000) { staging.await() })
            assertTrue(withTimeout(5_000) { joined.await() })
            val requests = transport.requests.size

            assertTrue(second.updateBundle())
            assertEquals(1, state.stageCount.get())
            assertEquals(requests, transport.requests.size)
        }

    @Test
    fun `an update of the same target that waited on the lock is staged`() =
        runBlocking {
            val state = FakeState()
            val catalogRoutes = routes(minorCatalog())
            val transport = FakeTransport(catalogRoutes)
            val checker = NativeUpdateChecker(state, transport)
            val first = checker.checkForUpdate(OPTIONS)!!
            val second = checker.checkForUpdate(OPTIONS)!!

            // A check holds the lock while both results queue for it.
            val catalogHeld = CompletableDeferred<Unit>()
            transport.handler = { request ->
                catalogHeld.await()
                catalogRoutes(request)
            }
            val check = async(Dispatchers.Default) { checker.checkForUpdate(OPTIONS) }
            delay(100)
            transport.handler = catalogRoutes
            val firstStaging = async(Dispatchers.Default) { first.updateBundle() }
            val secondStaging = async(Dispatchers.Default) { second.updateBundle() }
            delay(100)
            catalogHeld.complete(Unit)

            withTimeout(5_000) { check.await() }
            assertTrue(withTimeout(5_000) { firstStaging.await() })
            assertTrue(withTimeout(5_000) { secondStaging.await() })
            assertEquals(1, state.stageCount.get())
        }

    @Test
    fun `a retained result of a committed target is staged while its selection is current`() =
        runBlocking {
            val state = FakeState()
            var catalogBody = minorCatalog()
            val transport = FakeTransport { request -> routes(catalogBody)(request) }
            val checker = NativeUpdateChecker(state, transport)
            val first = checker.checkForUpdate(OPTIONS)!!
            val second = checker.checkForUpdate(OPTIONS)!!
            val third = checker.checkForUpdate(OPTIONS)!!

            assertTrue(first.updateBundle())
            val requests = transport.requests.size
            assertTrue(second.updateBundle())
            assertEquals(1, state.stageCount.get())
            assertEquals(requests, transport.requests.size)

            // A newer catalog supersedes the selection without staging anything.
            catalogBody = catalog(listOf(release(RELEASE_B, BUNDLE_B)), generation = 2)
            checker.checkForUpdate(OPTIONS)
            assertThrows(StaleReleaseCatalogException::class.java) { runBlocking { third.updateBundle() } }
            // So does the result that staged it.
            assertThrows(StaleReleaseCatalogException::class.java) { runBlocking { first.updateBundle() } }
            assertEquals(1, state.stageCount.get())
        }

    @Test
    fun `an artifact response that is not strict JSON is invalid`() =
        runBlocking {
            val state = FakeState()
            val catalogRoutes = routes(minorCatalog())
            val transport =
                FakeTransport { request ->
                    // org.json reads the object and ignores what follows; JSON.parse rejects it.
                    if (request.url == ARTIFACT_URL) ok(artifact() + " trailing") else catalogRoutes(request)
                }
            val checker = NativeUpdateChecker(state, transport)
            val update = checker.checkForUpdate(OPTIONS)!!

            assertThrows(InvalidUpdateResponseException::class.java) { runBlocking { update.updateBundle() } }
            assertEquals(0, state.stageCount.get())
        }

    @Test
    fun `a progress listener removed during a report is not called`() {
        val fanout = ProgressFanout()
        val received = mutableListOf<Double>()
        val later: (Double) -> Unit = { received.add(it) }
        // The first listener's caller stops waiting while the report runs.
        fanout.add { fanout.remove(later) }
        fanout.add(later)

        fanout.report(0.5)

        assertTrue(received.isEmpty())
    }

    @Test
    fun `a timeout too large for nanoseconds does not expire at once`() =
        runBlocking {
            val checker = NativeUpdateChecker(FakeState(), FakeTransport(routes(forcedCatalog())))

            val result = checker.prepare(OPTIONS, Long.MAX_VALUE, null)

            assertEquals(RELEASE_B, (result as HotUpdaterPrepareResult.Ready).update.id)
        }

    @Test
    fun `a hostless artifact URL is invalid`() =
        runBlocking {
            for (url in listOf("https://", "https:///manifest.json")) {
                val state = FakeState()
                val catalogRoutes = routes(minorCatalog())
                val transport =
                    FakeTransport { request ->
                        if (request.url == ARTIFACT_URL) {
                            ok(artifact().replace("https://cdn.example.com/b/manifest.json", url))
                        } else {
                            catalogRoutes(request)
                        }
                    }
                val checker = NativeUpdateChecker(state, transport)
                val update = checker.checkForUpdate(OPTIONS)!!

                assertThrows(InvalidUpdateResponseException::class.java) { runBlocking { update.updateBundle() } }
                assertEquals(0, state.stageCount.get())
            }
        }

    @Test
    fun `a 200 whose body breaks is reported before the check fails`() =
        runBlocking {
            val state = FakeState()
            val transport =
                FakeTransport {
                    throw UpdateResponseBodyException(
                        UpdateCheckResponse(200, "OK", emptyMap(), null),
                        java.io.IOException("connection reset"),
                    )
                }
            val checker = NativeUpdateChecker(state, transport)

            assertThrows(java.io.IOException::class.java) { runBlocking { checker.checkForUpdate(OPTIONS) } }

            val response = state.httpResponses().single()
            assertEquals(200, response.getInt("status"))
            assertTrue(response.isNull("body"))
            assertEquals("onUpdateError", state.events().single().getString("name"))
        }

    @Test
    fun `a check the prepare deadline ends is reported as a timeout`() =
        runBlocking {
            val state = FakeState()
            val transport =
                FakeTransport {
                    delay(5_000)
                    ok(minorCatalog())
                }
            val checker = NativeUpdateChecker(state, transport)

            assertTrue(checker.prepare(OPTIONS, 200, null) is HotUpdaterPrepareResult.Failed)

            val failure = state.events().single { it.getString("name") == "onUpdateError" }.getJSONObject("payload")
            assertEquals("check", failure.getString("stage"))
            assertEquals("network", failure.getString("reason"))
            assertEquals("timeout", failure.getString("transport"))
        }

    @Test
    fun `a reset drops the queued downloads of the bundles it deletes`() =
        runBlocking {
            val state = FakeState()
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))
            assertTrue(checker.checkForUpdate(OPTIONS)!!.updateBundle())
            assertTrue(state.events().any { it.getString("name") == "onBundleDownloaded" })

            assertTrue(checker.resetChannel { true })

            assertTrue(state.events().none { it.getString("name") == "onBundleDownloaded" })
            assertTrue(state.events().any { it.getString("name") == "onUpdateCheck" })
        }

    @Test
    fun `a reset waits for a background download`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))
            assertTrue(checker.prepare(OPTIONS, 5_000, null) is HotUpdaterPrepareResult.Pending)
            state.stageEntered.await()

            val reset = async(Dispatchers.Default) { checker.whenIdle { state.stageCount.get() } }
            delay(100)
            assertFalse(reset.isCompleted)
            gate.complete(Unit)

            assertEquals(1, withTimeout(5_000) { reset.await() })
            assertTrue(state.staged.isCompleted)
        }

    @Test
    fun `prepare joins a running download only for the same request`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))
            val first = checker.prepare(OPTIONS, 5_000, null) as HotUpdaterPrepareResult.Pending
            state.stageEntered.await()

            val otherChannel =
                HotUpdaterCheckOptions(
                    baseURL = OPTIONS.baseURL,
                    updateStrategy = OPTIONS.updateStrategy,
                    channel = "beta",
                )
            val otherKey =
                HotUpdaterCheckOptions(
                    baseURL = OPTIONS.baseURL,
                    updateStrategy = OPTIONS.updateStrategy,
                    requestHeaders = mapOf("Authorization" to "Bearer other"),
                )
            val other = checker.prepare(otherChannel, 200, null)
            val otherCredentials = checker.prepare(otherKey, 200, null)
            val cohort = state.cohortValue
            state.cohortValue = "501"
            val otherCohort = checker.prepare(OPTIONS, 200, null)
            state.cohortValue = cohort
            val same = checker.prepare(OPTIONS, 200, null)

            assertTrue(other is HotUpdaterPrepareResult.Failed)
            assertTrue(otherCredentials is HotUpdaterPrepareResult.Failed)
            // A prepare its deadline ended while waiting reports a check timeout.
            val timeouts =
                state.events().filter { it.getString("name") == "onUpdateError" }.map { it.getJSONObject("payload") }
            assertTrue(timeouts.any { it.getString("stage") == "check" && it.optString("transport") == "timeout" })
            // The prepare that waited under cohort 501 reports its timeout under 501.
            assertTrue(
                state.queued().any { it.getString("name") == "onUpdateError" && it.getString("build").endsWith("|501") },
            )
            assertTrue(otherCohort is HotUpdaterPrepareResult.Failed)
            assertSame(first.update, (same as HotUpdaterPrepareResult.Pending).update)
            gate.complete(Unit)
            Unit
        }

    @Test
    fun `a joined prepare checks again when the staging fails before its deadline`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state =
                FakeState().apply {
                    stageGate = gate
                    // The first caller's shorter deadline ended its artifact request.
                    nextStageError = java.io.IOException("timeout")
                }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))
            assertTrue(checker.prepare(OPTIONS, 200, null) is HotUpdaterPrepareResult.Pending)

            val later = async(Dispatchers.Default) { checker.prepare(OPTIONS, 10_000, null) }
            delay(100)
            gate.complete(Unit)

            assertTrue(withTimeout(10_000) { later.await() } is HotUpdaterPrepareResult.Ready)
            assertEquals(2, state.stageCount.get())
        }

    @Test
    fun `the deadline does not bound a required update's artifact request`() =
        runBlocking {
            val state = FakeState()
            val transport = FakeTransport(routes(forcedCatalog()))
            val checker = NativeUpdateChecker(state, transport)

            checker.prepare(OPTIONS, 1_000, null)
            withTimeout(5_000) { state.staged.await() }

            // The staging outlives prepare, so its request keeps the request timeout.
            assertEquals(5_000L, transport.requests.single { it.url == ARTIFACT_URL }.timeoutMillis)
        }

    @Test
    fun `the deadline covers the wait for another check holding the lock`() =
        runBlocking {
            val release = CompletableDeferred<Unit>()
            val requested = CompletableDeferred<Unit>()
            val state = FakeState()
            val body = minorCatalog()
            val checker =
                NativeUpdateChecker(
                    state,
                    FakeTransport { request ->
                        requested.complete(Unit)
                        release.await()
                        if (request.url == CATALOG_URL) ok(body) else ok(artifact())
                    },
                )
            val custom = async(Dispatchers.Default) { checker.checkForUpdate(OPTIONS) }
            requested.await()

            val started = System.nanoTime()
            val result = checker.prepare(OPTIONS, 200, null)

            assertTrue(elapsedMillis(started) < 1_000)
            assertTrue((result as HotUpdaterPrepareResult.Failed).error is TimeoutException)
            assertNull(result.update)
            release.complete(Unit)
            assertEquals(RELEASE_B, withTimeout(5_000) { custom.await() }?.id)
        }

    @Test
    fun `the deadline covers the catalog request`() =
        runBlocking {
            val state = FakeState()
            val transport =
                FakeTransport {
                    delay(10_000)
                    ok(minorCatalog())
                }
            val checker = NativeUpdateChecker(state, transport)

            val started = System.nanoTime()
            val result = checker.prepare(OPTIONS, 300, null)

            assertTrue(elapsedMillis(started) < 1_500)
            assertTrue(result is HotUpdaterPrepareResult.Failed)
            assertNull((result as HotUpdaterPrepareResult.Failed).update)
            assertTrue(transport.requests.single().timeoutMillis <= 300)
        }

    @Test
    fun `updateBundle joins a running staging of the same update`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))
            val update = checker.checkForUpdate(OPTIONS)!!

            val first = async(Dispatchers.Default) { update.updateBundle() }
            state.stageEntered.await()
            val second = async(start = CoroutineStart.UNDISPATCHED) { update.updateBundle() }
            gate.complete(Unit)

            assertTrue(withTimeout(5_000) { first.await() })
            assertTrue(withTimeout(5_000) { second.await() })
            assertEquals(1, state.stageCount.get())
        }

    @Test
    fun `a staging joins only the same selection`() =
        runBlocking {
            // The same Release from another catalog generation is another
            // selection, with its own guard and receipt, so it must not join.
            val transport = FakeTransport(routes(minorCatalog()))
            val checker = NativeUpdateChecker(FakeState(), transport)
            val first = checker.checkForUpdate(OPTIONS)!!
            val again = NativeUpdateChecker(FakeState(), transport).checkForUpdate(OPTIONS)!!
            transport.handler = routes(catalog(listOf(release(RELEASE_B, BUNDLE_B)), generation = 2))
            val newer = checker.checkForUpdate(OPTIONS)!!

            assertEquals(first.targetKey, again.targetKey)
            assertNotEquals(first.targetKey, newer.targetKey)
        }

    @Test
    fun `a non-positive timeout fails`() =
        runBlocking {
            val transport = FakeTransport(routes(minorCatalog()))
            val checker = NativeUpdateChecker(FakeState(), transport)

            assertTrue(checker.prepare(OPTIONS, 0, null) is HotUpdaterPrepareResult.Failed)
            assertTrue(transport.requests.isEmpty())
        }

    @Test
    fun `an invalid baseURL fails prepare and throws from checkForUpdate`() =
        runBlocking {
            val transport = FakeTransport(routes(minorCatalog()))
            val state = FakeState()
            val checker = NativeUpdateChecker(state, transport)
            for (baseURL in listOf("updates.example.com", "https://", "https:///api")) {
                val options = HotUpdaterCheckOptions(baseURL = baseURL, updateStrategy = HotUpdaterUpdateStrategy.APP_VERSION)

                val result = checker.prepare(options, 1_000, null)
                assertTrue((result as HotUpdaterPrepareResult.Failed).error is IllegalArgumentException)
                try {
                    checker.checkForUpdate(options)
                    fail("Expected the check to fail")
                } catch (_: IllegalArgumentException) {
                }
            }
            assertTrue(transport.requests.isEmpty())
            // Reported as JavaScript reports a check whose request fails.
            val events = state.events()
            assertEquals(6, events.size)
            assertTrue(events.all { it.getString("name") == "onUpdateError" })
            assertEquals("check", events.first().getJSONObject("payload").getString("stage"))
        }

    @Test
    fun `a catalog response is reported as the catalog under an artifacts base path`() =
        runBlocking {
            val state = FakeState()
            val transport = FakeTransport { UpdateCheckResponse(500, "Internal Server Error", emptyMap(), "oops") }
            val checker = NativeUpdateChecker(state, transport)
            val options =
                HotUpdaterCheckOptions(
                    baseURL = "https://updates.example.com/artifacts/hot-updater",
                    updateStrategy = HotUpdaterUpdateStrategy.APP_VERSION,
                )

            checker.prepare(options, 1_000, null)

            assertEquals("catalog", state.httpResponses().single().getString("resource"))
        }

    @Test
    fun `an HTTP 500 from the catalog throws, fails prepare, and queues onUpdateError`() =
        runBlocking {
            val state = FakeState()
            val transport = FakeTransport { UpdateCheckResponse(500, "Internal Server Error", emptyMap(), "oops") }
            val checker = NativeUpdateChecker(state, transport)

            try {
                checker.checkForUpdate(OPTIONS)
                fail("Expected the check to fail")
            } catch (error: UpdateHttpException) {
                assertEquals(500, error.status)
            }

            val event = state.events().single()
            assertEquals("onUpdateError", event.getString("name"))
            val payload = event.getJSONObject("payload")
            assertEquals("check", payload.getString("stage"))
            assertEquals("http", payload.getString("reason"))
            assertEquals("catalog", payload.getString("resource"))
            assertEquals(500, payload.getInt("httpStatus"))
            assertEquals("production", payload.getString("channel"))
            assertEquals(MIN_BUNDLE_ID, payload.getString("bundleId"))
            assertTrue(payload.isNull("releaseId"))
            assertEquals("appVersion", payload.getString("updateStrategy"))
            assertEquals("Request failed with HTTP 500 Internal Server Error", payload.getString("message"))
            assertFalse(payload.has("targetBundleId"))
            assertFalse(payload.has("transport"))

            val result = checker.prepare(OPTIONS, 1_000, null)
            assertTrue((result as HotUpdaterPrepareResult.Failed).error is UpdateHttpException)
            assertNull(result.update)
            assertEquals(2, state.events().size)
        }

    @Test
    fun `a failed required update fails prepare with the update`() =
        runBlocking {
            val state =
                FakeState().apply {
                    stageError = HotUpdaterException.downloadFailed(failure = UpdateFailure.http(403, "AccessDenied"))
                }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(forcedCatalog())))

            val result = checker.prepare(OPTIONS, 5_000, null) as HotUpdaterPrepareResult.Failed

            assertEquals("DOWNLOAD_FAILED", (result.error as HotUpdaterException).code)
            assertEquals(RELEASE_B, result.update?.id)
            val payload = state.events().last().getJSONObject("payload")
            assertEquals("download", payload.getString("stage"))
            assertEquals("http", payload.getString("reason"))
            assertEquals(403, payload.getInt("httpStatus"))
            assertEquals("AccessDenied", payload.getString("originCode"))
            assertEquals(BUNDLE_B, payload.getString("targetBundleId"))
            assertEquals(RELEASE_B, payload.getString("targetReleaseId"))
        }

    @Test
    fun `an unclassified staging failure queues no onUpdateError`() =
        runBlocking {
            val state = FakeState().apply { stageError = HotUpdaterException.bundleInCrashedHistory(BUNDLE_B) }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))

            try {
                checker.checkForUpdate(OPTIONS)!!.updateBundle()
                fail("Expected the update to fail")
            } catch (error: HotUpdaterException) {
                assertEquals("BUNDLE_IN_CRASHED_HISTORY", error.code)
            }
            assertEquals(listOf("onUpdateCheck"), state.events().map { it.getString("name") })
        }

    @Test
    fun `an artifact network failure is a download error of the artifact`() =
        runBlocking {
            val state = FakeState()
            val catalogBody = minorCatalog()
            val transport =
                FakeTransport { request ->
                    if (request.url == CATALOG_URL) ok(catalogBody) else throw java.net.SocketTimeoutException("timeout")
                }
            val checker = NativeUpdateChecker(state, transport)

            try {
                checker.checkForUpdate(OPTIONS)!!.updateBundle()
                fail("Expected the update to fail")
            } catch (_: java.net.SocketTimeoutException) {
            }
            val payload = state.events().last().getJSONObject("payload")
            assertEquals("download", payload.getString("stage"))
            assertEquals("network", payload.getString("reason"))
            assertEquals("artifact", payload.getString("resource"))
            assertEquals("timeout", payload.getString("transport"))
        }

    @Test
    fun `an explicit channel checks and stages that channel`() =
        runBlocking {
            val state = FakeState()
            val betaKey = ReleaseCatalogs.encodeChannelKey("beta")
            val betaCatalogUrl = "$BASE_URL/release-catalogs/app-version/android/$betaKey/1.2.0"
            val betaCatalog = minorCatalog().replace(SCOPE_KEY, "v1:app-version:android:$betaKey")
            val transport =
                FakeTransport { request ->
                    when (request.url) {
                        betaCatalogUrl -> ok(betaCatalog)
                        ARTIFACT_URL -> ok(artifact())
                        else -> UpdateCheckResponse(404, "Not Found", emptyMap(), "")
                    }
                }
            val checker = NativeUpdateChecker(state, transport)

            val update = checker.checkForUpdate(HotUpdaterCheckOptions(BASE_URL, HotUpdaterUpdateStrategy.APP_VERSION, channel = "beta"))!!
            assertTrue(update.updateBundle())

            assertEquals("beta", state.staged.await().channel)
            assertEquals(
                "beta",
                state.staged
                    .await()
                    .selection.channel,
            )
        }

    @Test
    fun `an explicit channel while the channel is switched is an error`() =
        runBlocking {
            val state = FakeState().apply { channelName = "beta" }
            val transport = FakeTransport(routes(catalog(emptyList())))
            val checker = NativeUpdateChecker(state, transport)
            val options = HotUpdaterCheckOptions(BASE_URL, HotUpdaterUpdateStrategy.APP_VERSION, channel = "staging")

            try {
                checker.checkForUpdate(options)
                fail("Expected the check to fail")
            } catch (error: IllegalStateException) {
                assertEquals(
                    "Runtime channel is already switched to \"beta\". Call hotUpdater.resetChannel() before checking \"staging\".",
                    error.message,
                )
            }
            assertTrue(checker.prepare(options, 1_000, null) is HotUpdaterPrepareResult.Failed)
            assertTrue(transport.requests.isEmpty())
            assertTrue(state.events().isEmpty())
        }

    @Test
    fun `the event queue keeps the newest 20 of each name with when they occurred`() {
        val storage = mutableMapOf<String, String>()
        var now = 1_000L
        val queue =
            NativeUpdateEventQueue(
                getItem = { storage[it] },
                setItem = { key, value -> if (value == null) storage.remove(key) else storage[key] = value },
                build = { "1.2.0|build" },
                clock = { now++ },
            )

        queue.add("onUpdateError", JSONObject().put("index", -1))
        repeat(25) { index -> queue.add("onUpdateCheck", JSONObject().put("index", index)) }
        queue.add("onUpdateError", JSONObject().put("index", -2))

        val events = JSONArray(storage.getValue(NativeUpdateEventQueue.STORAGE_KEY))
        assertEquals(22, events.length())
        val checks = (0 until events.length()).map { events.getJSONObject(it) }.filter { it.getString("name") == "onUpdateCheck" }
        assertEquals(20, checks.size)
        assertEquals(5, checks.first().getJSONObject("payload").getInt("index"))
        assertEquals(24, checks.last().getJSONObject("payload").getInt("index"))
        assertEquals(-1, events.getJSONObject(0).getJSONObject("payload").getInt("index"))
        assertEquals(1_000L, events.getJSONObject(0).getLong("occurredAt"))
        assertEquals(1_026L, events.getJSONObject(21).getLong("occurredAt"))
    }

    @Test
    fun `taking the events drops those of another native build`() {
        val storage = mutableMapOf<String, String>()
        var build = "1.2.0|first"
        val queue =
            NativeUpdateEventQueue(
                getItem = { storage[it] },
                setItem = { key, value -> if (value == null) storage.remove(key) else storage[key] = value },
                build = { build },
            )
        queue.add("onBundleDownloaded", JSONObject().put("toBundleId", BUNDLE_B))

        // The app was upgraded before JavaScript took the event.
        build = "1.3.0|second"
        queue.add("onUpdateCheck", JSONObject().put("status", "UNCHANGED"))
        val taken = JSONArray(queue.take())

        assertEquals(1, taken.length())
        assertEquals("onUpdateCheck", taken.getJSONObject(0).getString("name"))
        assertFalse(storage.containsKey(NativeUpdateEventQueue.STORAGE_KEY))
    }

    @Test
    fun `events queued before a cohort change are not replayed under the new cohort`() =
        runBlocking {
            val state = FakeState()
            val transport =
                FakeTransport { UpdateCheckResponse(404, "Not Found", mapOf("X-Hot-Updater-Catalog" to "none"), "") }
            NativeUpdateChecker(state, transport).checkForUpdate(OPTIONS)

            fun take() =
                NativeUpdateEventQueue(state::getStorageItem, state::setStorageItem, build = {
                    NativeUpdateEventQueue.buildOf(state.getAppVersion(), state.getMinBundleId(), state.getCohort())
                }).take()

            state.cohortValue = "501"

            assertNull(take())
        }

    @Test
    fun `a staging's events report the cohort its check selected for`() =
        runBlocking {
            val gate = CompletableDeferred<Unit>()
            val state = FakeState().apply { stageGate = gate }
            val checker = NativeUpdateChecker(state, FakeTransport(routes(minorCatalog())))
            assertTrue(checker.prepare(OPTIONS, 5_000, null) is HotUpdaterPrepareResult.Pending)
            state.stageEntered.await()

            // The cohort changes while the staging selected for 500 downloads.
            state.cohortValue = "501"
            gate.complete(Unit)
            withTimeout(5_000) { state.staged.await() }
            delay(100)

            val selected =
                NativeUpdateEventQueue(state::getStorageItem, state::setStorageItem, build = {
                    NativeUpdateEventQueue.buildOf(state.getAppVersion(), state.getMinBundleId(), "500")
                }).take()
            val names = JSONArray(selected).let { events -> (0 until events.length()).map { events.getJSONObject(it).getString("name") } }
            assertTrue(names.contains("onBundleDownloaded"))
        }

    @Test
    fun `taking the events returns them once and clears the queue`() {
        val storage = mutableMapOf<String, String>()
        val queue =
            NativeUpdateEventQueue(
                getItem = { storage[it] },
                setItem = { key, value -> if (value == null) storage.remove(key) else storage[key] = value },
                build = { "1.2.0|build" },
            )
        assertNull(queue.take())

        queue.add("onBundleDownloaded", JSONObject().put("toBundleId", BUNDLE_B))
        val taken = JSONArray(queue.take())

        assertEquals("onBundleDownloaded", taken.getJSONObject(0).getString("name"))
        assertFalse(storage.containsKey(NativeUpdateEventQueue.STORAGE_KEY))
        assertNull(queue.take())
        storage[NativeUpdateEventQueue.STORAGE_KEY] = "not json"
        assertNull(queue.take())
        assertFalse(storage.containsKey(NativeUpdateEventQueue.STORAGE_KEY))
    }

    @Test
    fun `encodeURIComponent matches JavaScript`() {
        assertEquals("a%20b%2Fc%3F!~*'()-_.%C3%A9", encodeURIComponent("a b/c?!~*'()-_.é"))
        assertEquals(RELEASE_A, encodeURIComponent(RELEASE_A))
        assertEquals(BUNDLE_A, encodeURIComponent(BUNDLE_A))
    }

    private fun implWithStorage(storage: BundleStorageService): HotUpdaterImpl {
        val unsafeField = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe")
        unsafeField.isAccessible = true
        val unsafe = unsafeField.get(null)
        val allocateInstance = unsafe.javaClass.getMethod("allocateInstance", Class::class.java)
        val impl = allocateInstance.invoke(unsafe, HotUpdaterImpl::class.java) as HotUpdaterImpl
        setImplField(impl, "bundleStorage", storage)
        // Field initializers don't run without the constructor.
        setImplField(impl, "launchPreparationLock", Any())
        return impl
    }

    private fun setImplField(
        impl: HotUpdaterImpl,
        name: String,
        value: Any?,
    ) {
        val field = HotUpdaterImpl::class.java.getDeclaredField(name)
        field.isAccessible = true
        field.set(impl, value)
    }
}
