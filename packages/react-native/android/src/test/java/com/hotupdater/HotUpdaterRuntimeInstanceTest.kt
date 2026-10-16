package com.hotupdater

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class HotUpdaterRuntimeInstanceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @get:Rule
    val recoveryMonitoring = RecoveryMonitoringRule()

    private val context by lazy { InstanceTestContext(temporaryFolder.root) }
    private val registry = HotUpdaterInstanceRegistry { context, environment -> HotUpdaterImpl(context, environment) }

    @Test
    fun `a runtime that loaded a named instance's launch URL resolves to that name`() {
        val widget = environment("widget")
        registry.impl(context, widget)

        // Its impl alone doesn't claim the URL; handing it out does.
        assertEquals(MAIN, registry.resolveName(context, "assets://widget.android.bundle"))
        assertEquals("assets://widget.android.bundle", registry.launchURL(context, widget))

        assertEquals("widget", registry.resolveName(context, "assets://widget.android.bundle"))
        assertEquals(MAIN, registry.resolveName(context, "assets://index.android.bundle"))
    }

    @Test
    fun `the record keeps every launch URL a named instance hands out`() {
        var launchURL = "assets://widget.android.bundle"
        val registry =
            HotUpdaterInstanceRegistry { context, environment ->
                HotUpdaterImpl(
                    context,
                    FakeBundleStorageService(bundleId = null, launchBundleUrl = { launchURL }),
                    MemoryPreferences(),
                    environment,
                )
            }
        val widget = environment("widget")

        assertEquals("assets://widget.android.bundle", registry.launchURL(context, widget))
        assertEquals("widget", registry.resolveName(context, "assets://widget.android.bundle"))

        // A channel reset makes the next read select the launch again.
        launchURL = "assets://widget-next.android.bundle"
        assertTrue(runBlocking { registry.impl(context, widget).resetChannel() })
        assertEquals(launchURL, registry.launchURL(context, widget))

        assertEquals("widget", registry.resolveName(context, launchURL))
        // A runtime that still runs the earlier one belongs to the same name.
        assertEquals("widget", registry.resolveName(context, "assets://widget.android.bundle"))
    }

    @Test
    fun `a file inside a named instance's storage resolves to that name`() {
        val app = environment("app")
        val app2 = environment("app-2")
        registry.impl(context, app)
        registry.impl(context, app2)
        val appBundle = File(app.filesRoot(context), "bundle-store/bundle-a/index.android.bundle").path
        val app2Bundle = File(app2.filesRoot(context), "bundle-store/bundle-b/index.android.bundle").path

        // A bundle staged after the launch, which a reload loads, was never handed out.
        assertEquals("app", registry.resolveName(context, appBundle))
        assertEquals("app-2", registry.resolveName(context, app2Bundle))
        assertEquals("app", registry.resolveName(context, "file://$appBundle"))
        assertEquals("app-2", registry.resolveName(context, appBundle.replace("/app/", "/app/../app-2/")))
        assertEquals(MAIN, registry.resolveName(context, app.filesRoot(context)!!.path + "-old/bundle-store/index.android.bundle"))
    }

    @Test
    fun `a path through a symlink matches its target`() {
        val widget = environment("widget")
        registry.impl(context, widget)
        val bundle = File(widget.filesRoot(context), "bundle-store/bundle/index.android.bundle")
        bundle.parentFile!!.mkdirs()
        bundle.writeText("bundle")
        val linkedFiles = File(temporaryFolder.root, "linked-files")
        Files.createSymbolicLink(linkedFiles.toPath(), context.filesDir.toPath())

        val linkedBundle = File(linkedFiles, bundle.relativeTo(context.filesDir).path)
        assertEquals("widget", registry.resolveName(context, linkedBundle.path))
    }

    @Test
    fun `a name without an impl never matches`() {
        val widget = environment("widget")
        registry.register(widget)

        assertEquals(
            MAIN,
            registry.resolveName(context, File(widget.filesRoot(context), "bundle-store/bundle/index.android.bundle").path),
        )
        assertNull(registry.impl("widget"))
    }

    @Test
    fun `main's bundles, the development server, and unknown URLs resolve to main`() {
        registry.launchURL(context, environment("widget"))

        listOf(
            null,
            "",
            "assets://index.android.bundle",
            File(context.filesDir, "bundle-store/bundle/index.android.bundle").path,
            File(context.filesDir, "hot-updater-instances/other/bundle-store/bundle/index.android.bundle").path,
            "http://10.0.2.2:8081/index.bundle?platform=android&dev=true",
            "hot-updater-instances/widget/bundle-store/bundle/index.android.bundle",
        ).forEach { url -> assertEquals("$url", MAIN, registry.resolveName(context, url)) }
    }

    @Test
    fun `two names that hand out the same launch URL can't claim it`() {
        registry.launchURL(context, environment("widget", bundleAssetName = "shared.android.bundle"))
        registry.launchURL(context, environment("widget-2", bundleAssetName = "shared.android.bundle"))

        assertEquals(MAIN, registry.resolveName(context, "assets://shared.android.bundle"))
    }

    @Test
    fun `a module resolves its runtime's instance once the runtime has a source URL`() {
        val widget = environment("widget")
        val widgetURL = registry.launchURL(context, widget)
        val mainImpl = allocateImpl()
        var sourceURL: String? = null
        val runtime = HotUpdaterRuntimeInstance(context, { sourceURL }, registry) { mainImpl }

        // No bundle loaded yet: main serves, and nothing is kept.
        assertEquals(MAIN, runtime.name)
        assertSame(mainImpl, runtime.impl)
        assertNull(runtime.reloadUnsupportedReason())
        sourceURL = ""
        assertEquals(MAIN, runtime.name)

        sourceURL = widgetURL
        assertEquals("widget", runtime.name)
        assertSame(registry.impl("widget"), runtime.impl)
        assertNotNull(runtime.reloadUnsupportedReason())

        // A runtime runs one bundle, so the first resolution stays.
        sourceURL = "assets://index.android.bundle"
        assertEquals("widget", runtime.name)
    }

    @Test
    fun `a module of main's runtime keeps serving main`() {
        registry.launchURL(context, environment("widget"))
        val mainImpl = allocateImpl()
        val runtime = HotUpdaterRuntimeInstance(context, { "assets://index.android.bundle" }, registry) { mainImpl }

        assertEquals(MAIN, runtime.name)
        assertSame(mainImpl, runtime.impl)
        assertNull(runtime.reloadUnsupportedReason())
    }

    private fun environment(
        name: String,
        bundleAssetName: String = "$name.android.bundle",
    ): HotUpdaterInstanceEnvironment =
        HotUpdaterInstanceEnvironment.of(
            HotUpdaterOptions("https://updates.example.com", name = name, bundleAssetName = bundleAssetName),
        )

    // Main's impl watches the app's activities and crashes; the module only
    // needs to tell it apart.
    private fun allocateImpl(): HotUpdaterImpl {
        val field = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe")
        field.isAccessible = true
        val unsafe = field.get(null)
        val allocateInstance = unsafe.javaClass.getMethod("allocateInstance", Class::class.java)
        return allocateInstance.invoke(unsafe, HotUpdaterImpl::class.java) as HotUpdaterImpl
    }

    private class MemoryPreferences : PreferencesService {
        private val values = HashMap<String, String>()

        override fun getItem(key: String): String? = values[key]

        override fun setItem(
            key: String,
            value: String?,
        ) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    companion object {
        private const val MAIN = HotUpdaterInstanceEnvironment.MAIN_NAME
    }
}
