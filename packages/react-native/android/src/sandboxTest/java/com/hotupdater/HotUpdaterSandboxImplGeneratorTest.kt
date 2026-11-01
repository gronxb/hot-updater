package com.hotupdater

import groovy.lang.GroovyClassLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.lang.reflect.InvocationTargetException

/** Runs the generator a sandbox build runs, on the source this package ships and on what it must refuse. */
class HotUpdaterSandboxImplGeneratorTest {
    private val generator =
        GroovyClassLoader(javaClass.classLoader).parseClass(
            File("src/sandbox/HotUpdaterSandboxImplGenerator.groovy"),
        )
    private val packaged = File("src/main/java/com/hotupdater/HotUpdaterImpl.kt").readText()

    private fun generate(source: String): String =
        try {
            generator.getMethod("generate", String::class.java, String::class.java).invoke(null, source, "sdk/HotUpdaterImpl.kt") as String
        } catch (error: InvocationTargetException) {
            throw error.targetException
        }

    private fun refusal(source: String): String {
        try {
            generate(source)
        } catch (error: IllegalStateException) {
            return error.message.orEmpty()
        }
        fail("expected a refusal")
        return ""
    }

    private val getterLine = "        if (environment.isMain) HotUpdaterSandboxDev.bundleOfThisProcess(context)?.let { return it }"
    private val anchor = "        val bundleUrl = prepareLaunchIfNeeded().bundleUrl"

    @Test
    fun `the packaged source generates with the line right before the launch's accounting`() {
        val lines = generate(packaged).split("\n")
        assertEquals(anchor, lines[lines.indexOf(getterLine) + 1])
        assertEquals(1, lines.count { it == getterLine })
        // After the restart process's return.
        val restart = lines.indexOfFirst { it.contains("HotUpdaterProcess.isRestartProcess(context)) {") }
        assertTrue(restart < lines.indexOf(getterLine))
        assertEquals(1, lines.count { it.contains("HotUpdaterSandboxDev.relaunch(reactContext)) return true") })
        assertEquals(1, lines.count { it.contains("HotUpdaterSandboxDev.storage(this.context, environment, bundleStorage)") })
        assertEquals(1, lines.count { it.contains("HotUpdaterSandboxDev.preferences(this.context, environment, preferences)") })
        assertEquals(1, lines.count { it.contains("HotUpdaterSandboxDev.keyValueFile(this.context, environment)") })
    }

    @Test
    fun `only the generator's lines differ from the source`() {
        val source = packaged.split("\n")
        val generated = generate(packaged).split("\n").drop(1)
        assertEquals(source.size + 2, generated.size)
        val added = generated.filter { it.contains("HotUpdaterSandboxDev") }
        assertEquals(5, added.size)
        assertEquals(
            source.filterNot {
                it.startsWith("        this.bundleStorage =") || it.startsWith("        this.preferences =") ||
                    it.startsWith("        this.keyValueStorage =")
            },
            generated.filterNot { it.contains("HotUpdaterSandboxDev") },
        )
    }

    @Test
    fun `a user's patch stays in what's compiled`() {
        val patched = packaged.replace("fun getDefaultChannel(): String =", "// patched by the app\n    fun getDefaultChannel(): String =")
        assertTrue(generate(patched).contains("// patched by the app"))
    }

    @Test
    fun `CRLF line endings generate the same as LF`() {
        assertEquals(generate(packaged), generate(packaged.replace("\n", "\r\n")))
    }

    @Test
    fun `comments before the anchor don't count`() {
        assertTrue(generate(packaged.replace(anchor, "        // a comment\n\n$anchor")).contains(getterLine))
    }

    @Test
    fun `work moved before the insertion point refuses`() {
        val moved = packaged.replace(anchor, "        postCrashUpdateCheck?.startIfPending()\n$anchor")
        val message = refusal(moved)
        assertTrue(message, message.contains("sdk/HotUpdaterImpl.kt"))
        assertTrue(message, message.contains("does something else before"))
        assertTrue(message, message.contains("Use the version of @hot-updater/react-native"))
    }

    @Test
    fun `a removed restart check refuses`() {
        val removed =
            packaged.replace(
                "        if (HotUpdaterProcess.isRestartProcess(context)) {\n            return bundleStorage.getFallbackBundleURL()\n        }\n",
                "",
            )
        assertTrue(refusal(removed).contains("does something else before"))
    }

    @Test
    fun `a missing anchor refuses`() {
        assertTrue(refusal(packaged.replace(anchor, "        val bundleUrl = selectLaunch().bundleUrl")).contains("does something else"))
    }

    @Test
    fun `a duplicate anchor function refuses`() {
        val getter = "    fun getJSBundleFile(): String {"
        assertTrue(refusal(packaged.replace(getter, "$getter\n        return \"\"\n    }\n\n$getter")).contains("found 2"))
    }

    @Test
    fun `a missing constructor assignment refuses`() {
        assertTrue(refusal(packaged.replace("        this.preferences = preferences\n", "")).contains("this.preferences = preferences"))
    }

    @Test
    fun `a duplicate class refuses`() {
        assertTrue(refusal("$packaged\nclass HotUpdaterImpl {\n}\n").contains("doesn't declare HotUpdaterImpl once"))
    }

    @Test
    fun `the generated file never keeps the packaged accounting first`() {
        val generated = generate(packaged)
        assertFalse(generated.indexOf(anchor) < generated.indexOf(getterLine))
    }
}
