package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class HotUpdaterInstanceEnvironmentTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    private val buildFingerprintHash = HotUpdaterConfig.buildFingerprintHash

    // Not the fingerprint the test app's build embedded.
    @Before
    fun clearBuildFingerprint() {
        HotUpdaterConfig.buildFingerprintHash = null
    }

    @After
    @Suppress("DEPRECATION")
    fun clearConfig() {
        HotUpdaterConfig.clear()
        HotUpdaterConfig.buildFingerprintHash = buildFingerprintHash
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
        // main refuses another channel, as a named instance does.
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta"))
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta"))
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "production"))
        }
    }

    @Test
    fun `main honors its options' channel fingerprint hash and public key`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main

        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "app-fp", publicKey = "APP KEY"))

        assertEquals("beta", main.defaultChannel(context))
        assertEquals("app-fp", main.fingerprintHash(context))
        assertEquals("APP KEY", main.publicKey(context))
        assertEquals("HotUpdaterPrefs_app-fp_${MIN_BUNDLE_ID}_beta", main.isolationKey(context, MIN_BUNDLE_ID))
        assertEquals("beta", HotUpdater.getChannel(context))
        assertEquals("app-fp", HotUpdater.getFingerprintHash(context))
    }

    @Test
    @Suppress("DEPRECATION")
    fun `main refuses options that contradict its configuration`() {
        val context = InstanceTestContext(temporaryFolder.root)

        // Options against earlier options.
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "app-fp"))
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, fingerprintHash = "other-fp"))
        }
        HotUpdaterConfig.clear()

        // Options against HotUpdater.configure.
        HotUpdater.configure(fingerprintHash = "app-fp", publicKey = "APP KEY", channel = "beta")
        listOf(
            HotUpdaterOptions(BASE_URL, channel = "production"),
            HotUpdaterOptions(BASE_URL, fingerprintHash = "other-fp"),
            HotUpdaterOptions(BASE_URL, publicKey = "OTHER KEY"),
        ).forEach { options ->
            assertThrows(IllegalArgumentException::class.java) { HotUpdater.init(context, options) }
        }
        // A refused init records nothing.
        assertThrows(IllegalArgumentException::class.java) {
            MainInstanceConfiguration.shared.claim(HotUpdaterOptions(BASE_URL, channel = "beta", publicKey = "OTHER KEY"))
        }
        assertEquals("APP KEY", HotUpdaterConfig.publicKey)
        HotUpdaterConfig.clear()

        // Options after main's impl exists: it keeps the values it was created with.
        HotUpdater.configure(channel = "beta")
        val createdWith = MainImplValues.read(context)
        MainInstanceConfiguration.shared.claim(HotUpdaterOptions(BASE_URL, channel = "beta"), createdWith)
        listOf(
            HotUpdaterOptions(BASE_URL, channel = "production"),
            HotUpdaterOptions(BASE_URL, fingerprintHash = "app-fp"),
            HotUpdaterOptions(BASE_URL, publicKey = "APP KEY"),
        ).forEach { options ->
            assertThrows(IllegalArgumentException::class.java) {
                MainInstanceConfiguration.shared.claim(options, createdWith)
            }
        }
        assertNull(HotUpdaterConfig.fingerprintHash)
        assertNull(HotUpdaterConfig.publicKey)

        // HotUpdater.configure after the impl exists changes what main reads,
        // not the key its stored bundles were created with.
        HotUpdater.configure(channel = "alpha")
        assertEquals("alpha", HotUpdaterInstanceEnvironment.main.defaultChannel(context))
        assertThrows(IllegalArgumentException::class.java) {
            MainInstanceConfiguration.shared.claim(HotUpdaterOptions(BASE_URL, channel = "alpha"), createdWith)
        }
        MainInstanceConfiguration.shared.claim(HotUpdaterOptions(BASE_URL, channel = "beta"), createdWith)
    }

    @Test
    @Suppress("DEPRECATION")
    fun `main's impl reads only the snapshot it was created with`() {
        val context = InstanceTestContext(temporaryFolder.root)
        HotUpdaterConfig.configure(fingerprintHash = "app-fp", publicKey = "APP KEY", channel = "beta")
        val configuration = MainInstanceConfiguration()
        var implEnvironment: HotUpdaterInstanceEnvironment? = null

        val impl =
            configuration.createImpl(context) { appContext, environment ->
                // Writes that land after the snapshot and before the impl is built.
                HotUpdaterConfig.channel = "alpha"
                HotUpdaterConfig.fingerprintHash = "other-fp"
                HotUpdaterConfig.publicKey = "OTHER KEY"
                HotUpdaterConfig.isolationKey = "host-key"
                implEnvironment = environment
                HotUpdaterImpl(appContext, environment)
            }

        val environment = implEnvironment!!
        assertEquals("beta", impl.getDefaultChannel())
        assertEquals("beta", impl.getChannel())
        assertEquals("app-fp", impl.getFingerprintHash())
        assertEquals("APP KEY", environment.publicKey(context))
        assertEquals("HotUpdaterPrefs_app-fp_${MIN_BUNDLE_ID}_beta", environment.isolationKey(context, MIN_BUNDLE_ID))
        val createdWith = configuration.createdWith!!
        assertEquals(
            listOf("beta", "app-fp", "APP KEY", null),
            listOf(createdWith.channel, createdWith.fingerprintHash, createdWith.publicKey, createdWith.isolationKey),
        )
        // Main's static entry points read HotUpdaterConfig as it is now.
        assertEquals("alpha", HotUpdaterInstanceEnvironment.main.defaultChannel(context))
        assertEquals("host-key", HotUpdaterInstanceEnvironment.main.isolationKey(context))
    }

    @Test
    @Suppress("DEPRECATION")
    fun `main's options left null keep HotUpdater configure's values`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main
        HotUpdater.configure(fingerprintHash = "app-fp", publicKey = "APP KEY", channel = "beta", isolationKey = "host-key")

        listOf(
            HotUpdaterOptions(BASE_URL),
            // An empty string sets nothing, as in HotUpdater.configure.
            HotUpdaterOptions(BASE_URL, channel = "", fingerprintHash = "", publicKey = ""),
            HotUpdaterOptions(BASE_URL, channel = "beta", publicKey = "APP KEY"),
        ).forEach { options ->
            HotUpdater.init(context, options)

            assertEquals("beta", main.defaultChannel(context))
            assertEquals("app-fp", main.fingerprintHash(context))
            assertEquals("APP KEY", main.publicKey(context))
            assertEquals("host-key", main.isolationKey(context))
        }
    }

    @Test
    @Suppress("DEPRECATION")
    fun `HotUpdater configure still replaces main's options and warns once`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main
        val warnings = mutableListOf<String>()
        val logWarning = MainInstanceConfiguration.shared.logWarning
        MainInstanceConfiguration.shared.logWarning = { warnings += it }
        try {
            // Without options, configure is what it always was.
            HotUpdater.configure(channel = "staging")
            HotUpdaterConfig.clear()
            assertEquals(emptyList<String>(), warnings)

            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "app-fp", publicKey = "APP KEY"))
            HotUpdater.configure(fingerprintHash = "app-fp", publicKey = "OTHER KEY", channel = "production")

            assertEquals("production", main.defaultChannel(context))
            assertEquals("app-fp", main.fingerprintHash(context))
            assertEquals("OTHER KEY", main.publicKey(context))
            val warning = warnings.single()
            assertTrue(warning, warning.contains("channel \"beta\" with \"production\""))
            assertTrue(warning, warning.contains("publicKey"))
            assertFalse(warning, warning.contains("fingerprintHash \""))
            assertFalse(warning, warning.contains("APP KEY"))
            assertTrue(warning, warning.contains("only through HotUpdaterOptions"))

            // Once: the values are configure's now.
            HotUpdater.configure(channel = "staging")
            assertEquals("staging", main.defaultChannel(context))
            assertNull(main.fingerprintHash(context))
            assertEquals(1, warnings.size)
        } finally {
            MainInstanceConfiguration.shared.logWarning = logWarning
        }
    }

    @Test
    @Suppress("DEPRECATION")
    fun `a deprecated setter that replaces main's options warns once for that value`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main
        val warnings = mutableListOf<String>()
        val logWarning = MainInstanceConfiguration.shared.logWarning
        MainInstanceConfiguration.shared.logWarning = { warnings += it }
        try {
            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "app-fp"))
            assertEquals(emptyList<String>(), warnings)

            HotUpdaterConfig.channel = "alpha"
            assertEquals("alpha", main.defaultChannel(context))
            val warning = warnings.single()
            assertTrue(warning, warning.startsWith("HotUpdaterConfig.channel replaced the channel \"beta\" with \"alpha\""))
            assertTrue(warning, warning.contains("only through HotUpdaterOptions"))

            // The setter took the channel over, so configure replacing it again
            // is no override of the options; the fingerprint hash stays theirs.
            HotUpdater.configure(channel = "gamma", fingerprintHash = "app-fp")
            assertEquals(1, warnings.size)
            HotUpdaterConfig.fingerprintHash = "other-fp"
            assertEquals(1, warnings.size)
            assertEquals("other-fp", main.fingerprintHash(context))

            // Options again, then a setter that clears one of them.
            HotUpdaterConfig.clear()
            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, publicKey = "APP KEY"))
            HotUpdaterConfig.publicKey = ""
            assertNull(main.publicKey(context))
            assertTrue(warnings[1], warnings[1].startsWith("HotUpdaterConfig.publicKey replaced the publicKey that"))
            assertFalse(warnings[1], warnings[1].contains("APP KEY"))
            assertEquals(2, warnings.size)
        } finally {
            MainInstanceConfiguration.shared.logWarning = logWarning
        }
    }

    @Test
    @Suppress("DEPRECATION")
    fun `empty legacy values are no override in main's conflict checks`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main

        HotUpdater.configure(fingerprintHash = "", publicKey = "", channel = "")
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "production", fingerprintHash = "app-fp", publicKey = "APP KEY"))
        assertEquals("production", main.defaultChannel(context))
        assertEquals("app-fp", main.fingerprintHash(context))
        assertEquals("APP KEY", main.publicKey(context))
        HotUpdaterConfig.clear()

        HotUpdaterConfig.channel = ""
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta"))
        assertEquals("beta", main.defaultChannel(context))
        HotUpdaterConfig.clear()

        // After the impl exists: an empty legacy channel was the default one.
        HotUpdater.configure(channel = "", fingerprintHash = "", publicKey = "")
        val createdWith = MainImplValues.read(context)
        MainInstanceConfiguration.shared.claim(HotUpdaterOptions(BASE_URL, channel = "production"), createdWith)
        assertThrows(IllegalArgumentException::class.java) {
            MainInstanceConfiguration.shared.claim(HotUpdaterOptions(BASE_URL, fingerprintHash = "app-fp"), createdWith)
        }
    }

    @Test
    fun `main launches its own bundle asset`() {
        val context = InstanceTestContext(temporaryFolder.root)

        assertThrows(IllegalArgumentException::class.java) {
            HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, bundleAssetName = "x.android.bundle"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta", bundleAssetName = "x.android.bundle"))
        }
        // The refused init recorded nothing.
        assertEquals("production", HotUpdaterInstanceEnvironment.main.defaultChannel(context))
    }

    @Test
    fun `the fingerprint key is the fingerprint the build's min bundle id and the channel`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, fingerprintHash = "app-fp"))
        val widget = environment("widget", fingerprintHash = "widget-fp")

        assertEquals("HotUpdaterPrefs_app-fp_${MIN_BUNDLE_ID}_production", main.isolationKey(context, MIN_BUNDLE_ID))
        assertEquals("HotUpdaterInstancePrefs_widget_widget-fp_${MIN_BUNDLE_ID}_production", widget.isolationKey(context, MIN_BUNDLE_ID))
        // A new build, with a new min bundle id, gets a new key; the app version is no part of it.
        assertNotEquals(main.isolationKey(context, MIN_BUNDLE_ID), main.isolationKey(context, NEXT_MIN_BUNDLE_ID))
        assertFalse(main.isolationKey(context, MIN_BUNDLE_ID).contains("unknown"))
        // The default is this build's id.
        assertEquals(main.isolationKey(context, HotUpdaterImpl.getMinBundleId()), main.isolationKey(context))
    }

    @Test
    @Suppress("DEPRECATION")
    fun `the appVersion key and an explicit isolation key are unchanged`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main

        // Without a fingerprint, the app version (unknown here) keys the store, whatever the build.
        assertEquals("HotUpdaterPrefs_unknown_production", main.isolationKey(context, MIN_BUNDLE_ID))
        assertEquals("HotUpdaterPrefs_unknown_production", main.isolationKey(context, NEXT_MIN_BUNDLE_ID))
        assertEquals("HotUpdaterInstancePrefs_widget_unknown_production", environment("widget").isolationKey(context, MIN_BUNDLE_ID))

        HotUpdater.configure(fingerprintHash = "app-fp", isolationKey = "host-isolation-key")
        assertEquals("host-isolation-key", main.isolationKey(context, MIN_BUNDLE_ID))
        assertEquals("host-isolation-key", main.isolationKey(context, NEXT_MIN_BUNDLE_ID))
    }

    @Test
    @Suppress("DEPRECATION")
    fun `main derives every path and key it always has`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val main = HotUpdaterInstanceEnvironment.main

        assertSame(main, environment("main"))
        assertSame(
            main,
            HotUpdaterInstanceEnvironment.of(HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "fp", publicKey = "key")),
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
        assertEquals("HotUpdaterPrefs_app-fp_${MIN_BUNDLE_ID}_beta", main.isolationKey(context, MIN_BUNDLE_ID))
        assertEquals("beta", main.defaultChannel(context))
        assertEquals("app-fp", main.fingerprintHash(context))
        assertEquals("APP KEY", main.publicKey(context))

        HotUpdaterConfig.configure(isolationKey = "host-isolation-key")
        assertEquals("host-isolation-key", main.isolationKey(context))
    }

    @Test
    @Suppress("DEPRECATION")
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
        assertEquals("HotUpdaterInstancePrefs_widget_widget-fp_${MIN_BUNDLE_ID}_beta", widget.isolationKey(context, MIN_BUNDLE_ID))
        assertEquals("beta", widget.defaultChannel(context))
        assertEquals("widget-fp", widget.fingerprintHash(context))
        assertEquals("WIDGET KEY", widget.publicKey(context))
        assertEquals("assets://widget.android.bundle", widget.fallbackBundleURL)

        // Without its own values, a named instance reads its manifest values,
        // none here, never main's configuration.
        val plain = environment("plain")
        assertEquals("HotUpdaterInstancePrefs_plain_unknown_production", plain.isolationKey(context))
        assertEquals("production", plain.defaultChannel(context))
        assertNull(plain.fingerprintHash(context))
        assertNull(plain.publicKey(context))
        assertEquals("assets://plain.android.bundle", plain.fallbackBundleURL)

        // Nor do main's options reach it.
        HotUpdaterConfig.clear()
        HotUpdater.init(context, HotUpdaterOptions(BASE_URL, channel = "beta", fingerprintHash = "app-fp", publicKey = "APP KEY"))
        assertEquals("production", plain.defaultChannel(context))
        assertNull(plain.fingerprintHash(context))
        assertNull(plain.publicKey(context))
    }

    @Test
    fun `a named instance without its own fingerprint reads the one the build embedded`() {
        val context = InstanceTestContext(temporaryFolder.root)
        HotUpdaterConfig.buildFingerprintHash = "build-fp"
        // Main's programmatic fingerprint still never reaches it.
        HotUpdaterConfig.configure(fingerprintHash = "app-fp", publicKey = null, channel = null)

        val plain = environment("plain")
        assertEquals("build-fp", plain.fingerprintHash(context))
        assertEquals("HotUpdaterInstancePrefs_plain_build-fp_${MIN_BUNDLE_ID}_production", plain.isolationKey(context, MIN_BUNDLE_ID))
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
    fun `a named launch stays pending after it is selected`() {
        // Its own first content verifies it (InstanceRecoveryTest), as main's does.
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
        assertTrue(metadata.verificationPending)
        assertEquals("widget-bundle", metadata.stagingBundleId)
        assertEquals("PENDING", impl.notifyAppReady()["status"])
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

        assertThrows(IllegalArgumentException::class.java) { registry.register(context, environment("widget", channel = "production")) }
        assertThrows(IllegalArgumentException::class.java) { registry.impl(context, environment("widget", publicKey = "other")) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(context, HotUpdaterInstanceEnvironment.main) }
    }

    @Test
    fun `a name compares the configuration its options resolve to`() {
        val context = InstanceTestContext(temporaryFolder.root)
        val registry = HotUpdaterInstanceRegistry { _, _ -> allocateImpl() }

        // Without a manifest value, an omitted channel resolves to production,
        // and an omitted or empty fingerprint hash or public key to none.
        registry.register(context, environment("widget"))
        registry.register(context, environment("widget", channel = "production"))
        registry.register(context, environment("widget", channel = "production", fingerprintHash = "", publicKey = ""))
        assertThrows(IllegalArgumentException::class.java) { registry.register(context, environment("widget", channel = "beta")) }
        assertThrows(IllegalArgumentException::class.java) { registry.register(context, environment("widget", fingerprintHash = "fp")) }

        // The same through HotUpdater.init.
        fun resolved(channel: String?) =
            HotUpdaterOptions(BASE_URL, name = "init-resolved", channel = channel, bundleAssetName = "init-resolved.android.bundle")
        HotUpdater.init(context, resolved(channel = "production"))
        HotUpdater.init(context, resolved(channel = null))
        assertThrows(IllegalArgumentException::class.java) { HotUpdater.init(context, resolved(channel = "beta")) }
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
        fingerprintHash: String? = null,
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
            HotUpdaterOptions(
                BASE_URL,
                name = name,
                channel = channel,
                fingerprintHash = fingerprintHash,
                publicKey = publicKey,
                bundleAssetName = bundleAssetName,
            ),
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
        private const val MIN_BUNDLE_ID = "0190a1b2-c3d4-7000-8000-000000000000"
        private const val NEXT_MIN_BUNDLE_ID = "0190a1b2-c3d5-7000-8000-000000000000"
    }
}
