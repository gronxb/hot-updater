package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class HotUpdaterInstanceEnvironmentTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @After
    fun clearConfig() {
        HotUpdaterConfig.clear()
    }

    @Test
    fun `a named instance needs a bundle asset other than main's`() {
        // Main's runtime is told apart by the bundle it runs.
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, name = "widget"))
        }
        assertSame(HotUpdaterInstanceEnvironment.main, HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL)))
    }

    @Test
    fun `instance names are 1 to 32 lowercase letters digits or hyphens`() {
        listOf("main", "a", "chat-widget-2", "0", "a".repeat(32)).forEach { name ->
            assertEquals(name, environment(name).name)
        }
        listOf("", "Widget", "a".repeat(33), "a/b", "a_b", "a b", "../a", "widgét").forEach { name ->
            assertThrows("\"$name\"", IllegalArgumentException::class.java) { environment(name) }
        }
    }

    @Test
    fun `init refuses an invalid name and a name created with another configuration`() {
        val context = InstanceTestContext(temporaryFolder.root)

        assertThrows(IllegalArgumentException::class.java) {
            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, name = "Init-Widget"))
        }

        val first =
            HotUpdater.init(
                context,
                HotUpdaterOptions(BASE_URL, name = "init-widget", channel = "beta", bundleAssetName = "init-widget.android.bundle"),
            )
        assertEquals("init-widget", first.options.name)
        // Same configuration, other request defaults: the same state.
        HotUpdater.init(
            context,
            HotUpdaterOptions(
                BASE_URL,
                requestTimeoutMillis = 1_000,
                name = "init-widget",
                channel = "beta",
                bundleAssetName = "init-widget.android.bundle",
            ),
        )
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdater.init(
                context,
                HotUpdaterOptions(BASE_URL, name = "init-widget", channel = "production", bundleAssetName = "init-widget.android.bundle"),
            )
        }
        // main reads the manifest, so its options' configuration never conflicts.
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta"))
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "production"))
    }

    @Test
    fun `main derives every path and key it always has`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main

        assertSame(main, environment("main"))
        // main ignores the options' configuration and reads the manifest and HotUpdater.configure.
        assertSame(
            main,
            HotUpdaterInstanceEnvironment.of(
                HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "fp", publicKey = "key", bundleAssetName = "x.bundle"),
            ),
        )
        assertEquals(context.filesDir, main.filesRoot(context))
        assertEquals(File(context.noBackupFilesDir, "hot-updater/storage.json"), main.keyValueStorageFile(context))
        assertEquals(File(context.noBackupFilesDir, "hot-updater-release-catalog-cache"), main.releaseCatalogCacheDirectory(context))
        assertEquals("HotUpdaterPrefs_", main.preferencesPrefix)
        assertEquals("assets://index.android.bundle", main.fallbackBundleURL)
        assertEquals("HotUpdaterPrefs_unknown_production", main.isolationKey(context))
        assertEquals("production", main.defaultChannel(context))
        assertNull(main.fingerprintHash(context))
        assertNull(main.publicKey(context))

        HotUpdaterConfig.configure(fingerprintHash = "app-fp", publicKey = "APP KEY", channel = "beta")
        assertEquals("HotUpdaterPrefs_app-fp_unknown_beta", main.isolationKey(context))
        assertEquals("beta", main.defaultChannel(context))
        assertEquals("app-fp", main.fingerprintHash(context))
        assertEquals("APP KEY", main.publicKey(context))

        HotUpdaterConfig.configure(isolationKey = "host-isolation-key")
        assertEquals("host-isolation-key", main.isolationKey(context))
    }

    @Test
    fun `a named instance keeps its state beside main's with its own configuration`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val widget =
            HotUpdaterInstanceEnvironment.of(
                HotUpdaterOptions(
                    BASE_URL,
                    name = "widget",
                    channel = "beta",
                    fingerprintHash = "widget-fp",
                    publicKey = "WIDGET KEY",
                    bundleAssetName = "widget.android.bundle",
                ),
            )
        HotUpdaterConfig.configure(fingerprintHash = "app-fp", publicKey = "APP KEY", channel = "staging", isolationKey = "host-key")

        assertEquals(File(context.filesDir, "hot-updater-instances/widget"), widget.filesRoot(context))
        assertEquals(File(context.noBackupFilesDir, "hot-updater/instances/widget/storage.json"), widget.keyValueStorageFile(context))
        assertEquals(
            File(context.noBackupFilesDir, "hot-updater/instances/widget/release-catalog-cache"),
            widget.releaseCatalogCacheDirectory(context),
        )
        assertEquals("HotUpdaterInstancePrefs_widget_", widget.preferencesPrefix)
        // main's verbatim override is main's own key and never names a named instance's state.
        assertEquals("HotUpdaterInstancePrefs_widget_widget-fp_unknown_beta", widget.isolationKey(context))
        assertEquals("beta", widget.defaultChannel(context))
        assertEquals("widget-fp", widget.fingerprintHash(context))
        assertEquals("WIDGET KEY", widget.publicKey(context))
        assertEquals("assets://widget.android.bundle", widget.fallbackBundleURL)

        // Without its own values, a named instance reads the app's, as main does.
        val plain = environment("plain")
        assertEquals("HotUpdaterInstancePrefs_plain_app-fp_unknown_staging", plain.isolationKey(context))
        assertEquals("staging", plain.defaultChannel(context))
        assertEquals("app-fp", plain.fingerprintHash(context))
        assertEquals("APP KEY", plain.publicKey(context))
        assertEquals("assets://plain.android.bundle", plain.fallbackBundleURL)
    }

    @Test
    fun `each preferences sweep deletes only its own family's stale files`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main
        val widget = environment("widget")
        val widget2 = environment("widget-2")
        val files =
            setOf(
                main.isolationKey(context),
                "HotUpdaterPrefs_1.0.0_production",
                widget.isolationKey(context),
                "HotUpdaterInstancePrefs_widget_1.0.0_production",
                widget2.isolationKey(context),
                "HotUpdaterInstancePrefs_widget-2_1.0.0_production",
                "HotUpdaterCohort",
            )
        files.forEach { File(context.sharedPrefsDir, "$it.xml").writeText("<map />") }

        VersionedPreferencesService(context, main.isolationKey(context), main.preferencesPrefix)
        assertEquals(files - "HotUpdaterPrefs_1.0.0_production", remainingPreferences(context))

        VersionedPreferencesService(context, widget.isolationKey(context), widget.preferencesPrefix)
        assertEquals(
            files - "HotUpdaterPrefs_1.0.0_production" - "HotUpdaterInstancePrefs_widget_1.0.0_production",
            remainingPreferences(context),
        )
    }

    @Test
    fun `a named impl selects its own embedded bundle and stores beside main`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val mainStaleKey = "HotUpdaterPrefs_1.0.0_production"
        val widgetStaleKey = "HotUpdaterInstancePrefs_widget_1.0.0_production"
        listOf(mainStaleKey, widgetStaleKey).forEach { File(context.sharedPrefsDir, "$it.xml").writeText("<map />") }
        val widget = environment("widget", bundleAssetName = "widget.android.bundle")

        val impl = HotUpdaterImpl(context, widget)

        assertEquals("assets://widget.android.bundle", impl.getJSBundleFile())
        assertTrue(File(context.filesDir, "hot-updater-instances/widget/bundle-store").isDirectory)
        assertFalse(File(context.filesDir, "bundle-store").exists())
        // The named impl's sweep leaves main's preferences for main.
        assertEquals(setOf(mainStaleKey), remainingPreferences(context))

        impl.setStorageItem("plugins/insights/queue", "[]")
        assertTrue(File(context.noBackupFilesDir, "hot-updater/instances/widget/storage.json").isFile)
        assertFalse(File(context.noBackupFilesDir, "hot-updater/storage.json").exists())
        assertNull(
            KeyValueStorageService(HotUpdaterInstanceEnvironment.main.keyValueStorageFile(context)).getItem("plugins/insights/queue"),
        )
    }

    @Test
    fun `a named launch counts as verified once it is selected`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val widget = environment("widget")
        val root = widget.filesRoot(context)!!
        val isolationKey = widget.isolationKey(context)
        val bundleDir = File(root, "bundle-store/widget-bundle").apply { mkdirs() }
        File(bundleDir, "index.android.bundle").writeText("bundle")
        File(bundleDir, "manifest.json").writeText(
            JSONObject()
                .put("bundleId", "widget-bundle")
                .put("assets", JSONObject().put("index.android.bundle", JSONObject().put("fileHash", "hash")))
                .toString(),
        )
        val metadataFile = File(root, "bundle-store/${BundleMetadata.METADATA_FILENAME}")
        assertTrue(
            BundleMetadata(isolationKey = isolationKey, stagingBundleId = "widget-bundle", verificationPending = true)
                .saveToFile(metadataFile),
        )

        val impl = HotUpdaterImpl(context, widget)

        assertEquals(File(bundleDir, "index.android.bundle").absolutePath, impl.getJSBundleFile())
        val metadata = BundleMetadata.loadFromFile(metadataFile, isolationKey)!!
        assertFalse(metadata.verificationPending)
        assertFalse(metadata.launchInProgress)
        assertEquals("UPDATE_APPLIED", impl.notifyAppReady()["status"])

        // The next process keeps the bundle instead of rolling it back.
        val next = HotUpdaterImpl(context, widget)
        assertEquals(File(bundleDir, "index.android.bundle").absolutePath, next.getJSBundleFile())
        assertTrue(next.getCrashHistory().isEmpty())
    }

    @Test
    fun `the registry keeps one impl per name and one configuration per name`() {
        val created = mutableListOf<String>()
        val registry =
            HotUpdaterInstanceRegistry { _, environment ->
                created += environment.name
                allocateImpl()
            }
        val context = InstanceTestContext(temporaryFolder.root)
        val widget = environment("widget", channel = "beta")

        val first = registry.impl(context, widget)
        assertSame(first, registry.impl(context, environment("widget", channel = "beta")))
        assertNotSame(first, registry.impl(context, environment("widget-2")))
        assertEquals(listOf("widget", "widget-2"), created)

        assertThrows(IllegalArgumentException::class.java) { registry.register(environment("widget", channel = "production")) }
        assertThrows(IllegalArgumentException::class.java) { registry.impl(context, environment("widget", publicKey = "other")) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(HotUpdaterInstanceEnvironment.main) }
    }

    @Test
    fun `each name has its own update checker`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val checkerA = NativeUpdateCheck.checker(context, "checker-a") { allocateImpl() }

        assertSame(checkerA, NativeUpdateCheck.checker(context, "checker-a") { error("created twice") })
        assertNotSame(checkerA, NativeUpdateCheck.checker(context, "checker-b") { allocateImpl() })
    }

    @Test
    fun `native update events queue per name`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = KeyValueStorageService(HotUpdaterInstanceEnvironment.main.keyValueStorageFile(context))
        val widget = KeyValueStorageService(environment("widget").keyValueStorageFile(context))

        fun queue(storage: KeyValueStorageService) = NativeUpdateEventQueue(storage::getItem, storage::setItem, build = { "build" })

        queue(widget).add("onUpdateError", JSONObject().put("name", "widget"))
        queue(main).add("onUpdateError", JSONObject().put("name", "main"))

        assertEquals(listOf("main"), payloadNames(queue(main).take()))
        assertNull(queue(main).take())
        assertEquals(listOf("widget"), payloadNames(queue(widget).take()))
    }

    @Test
    fun `a named release catalog cache never evicts main's entries`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = catalogCache(HotUpdaterInstanceEnvironment.main.releaseCatalogCacheDirectory(context))
        val widget = catalogCache(environment("widget").releaseCatalogCacheDirectory(context))
        val count = ReleaseCatalogCacheService.DEFAULT_MAX_ENTRIES

        (0 until count).forEach { assertTrue(main.set("main-$it", "catalog")) }
        (0 until count).forEach { assertTrue(widget.set("widget-$it", "catalog")) }

        (0 until count).forEach { assertEquals("catalog", main.get("main-$it")) }
        (0 until count).forEach { assertEquals("catalog", widget.get("widget-$it")) }
    }

    private fun environment(
        name: String,
        channel: String? = null,
        publicKey: String? = null,
        bundleAssetName: String =
            if (name ==
                HotUpdaterInstanceEnvironment.MAIN_NAME
            ) {
                HotUpdaterInstanceEnvironment.DEFAULT_BUNDLE_ASSET_NAME
            } else {
                "$name.android.bundle"
            },
    ): HotUpdaterInstanceEnvironment =
        HotUpdaterInstanceEnvironment.of(
            HotUpdaterOptions(BASE_URL, name = name, channel = channel, publicKey = publicKey, bundleAssetName = bundleAssetName),
        )

    private fun remainingPreferences(context: InstanceTestContext): Set<String> =
        context.sharedPrefsDir
            .listFiles()!!
            .map { it.name.removeSuffix(".xml") }
            .toSet()

    private fun payloadNames(events: String?): List<String> {
        val array = JSONArray(events!!)
        return (0 until array.length()).map { array.getJSONObject(it).getJSONObject("payload").getString("name") }
    }

    private fun catalogCache(directory: File): ReleaseCatalogCacheService =
        ReleaseCatalogCacheService(
            rootDirectory = directory,
            atomicReader = { file -> if (file.isFile) file.readBytes() else null },
            atomicWriter = { destination, bytes ->
                val temporary = File.createTempFile("entry", ".tmp", destination.parentFile)
                temporary.writeBytes(bytes)
                Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
                true
            },
            atomicRemover = { file -> !file.exists() || file.delete() },
        )

    private fun allocateImpl(): HotUpdaterImpl {
        val field = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe")
        field.isAccessible = true
        val unsafe = field.get(null)
        val allocateInstance = unsafe.javaClass.getMethod("allocateInstance", Class::class.java)
        return allocateInstance.invoke(unsafe, HotUpdaterImpl::class.java) as HotUpdaterImpl
    }

    companion object {
        private const val BASE_URL = "https://updates.example.com"
    }
}
