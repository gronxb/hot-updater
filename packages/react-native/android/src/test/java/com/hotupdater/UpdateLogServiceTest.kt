package com.hotupdater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UpdateLogServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private var now = 1_000_000_000_000L

    private fun logFile(): File = File(temporaryFolder.newFolder(), "nested/${UpdateLogService.FILENAME}")

    private fun service(file: File): UpdateLogService = UpdateLogService(file, clock = { now })

    private fun check(bundleId: String): UpdateLogEvent =
        UpdateLogEvent(type = UpdateLogEvent.CHECK, outcome = UpdateLogEvent.UP_TO_DATE, bundleId = bundleId)

    private fun entries(json: String): List<JSONObject> = JSONArray(json).let { array -> (0 until array.length()).map(array::getJSONObject) }

    private fun bundleIds(log: UpdateLogService): List<String> = entries(log.read()).map { it.getString("bundleId") }

    @Test
    fun `reads what was appended, oldest first, with every field`() {
        val log = service(logFile())

        log.append(check("a"))
        log.append(
            UpdateLogEvent(
                type = UpdateLogEvent.DOWNLOAD,
                outcome = UpdateLogEvent.FAILED,
                bundleId = "b",
                fromBundleId = "a",
                releaseId = "release",
                channel = "beta",
                error =
                    JSONObject()
                        .put("code", "DOWNLOAD_FAILED")
                        .put("message", "failed")
                        .put("stage", "download")
                        .put("reason", "network"),
            ),
        )

        val (first, second) = entries(log.read())
        assertEquals(now, first.getLong("timestamp"))
        assertEquals("CHECK", first.getString("type"))
        assertEquals("a", first.getString("bundleId"))
        assertFalse(first.has("error"))
        assertEquals("FAILED", second.getString("outcome"))
        assertEquals("a", second.getString("fromBundleId"))
        assertEquals("release", second.getString("releaseId"))
        assertEquals("beta", second.getString("channel"))
        val error = second.getJSONObject("error")
        assertEquals("DOWNLOAD_FAILED", error.getString("code"))
        assertEquals("failed", error.getString("message"))
        assertEquals("download", error.getString("stage"))
        assertEquals("network", error.getString("reason"))
    }

    @Test
    fun `an empty or missing log reads as an empty list`() {
        assertEquals("[]", service(logFile()).read())
    }

    @Test
    fun `entries survive a new process`() {
        val file = logFile()
        service(file).apply {
            append(check("a"))
            read()
        }

        assertEquals(listOf("a"), bundleIds(service(file)))
    }

    @Test
    fun `reads keep only the newest entries`() {
        val log = service(logFile())
        repeat(UpdateLogService.MAX_ENTRIES + 5) { log.append(check("bundle-$it")) }

        val bundleIds = bundleIds(log)

        assertEquals(UpdateLogService.MAX_ENTRIES, bundleIds.size)
        assertEquals("bundle-5", bundleIds.first())
        assertEquals("bundle-${UpdateLogService.MAX_ENTRIES + 4}", bundleIds.last())
    }

    @Test
    fun `reads drop entries older than the retention`() {
        val log = service(logFile())
        log.append(check("old"))
        now += 1
        log.append(check("new"))

        now += UpdateLogService.MAX_AGE_MILLIS

        assertEquals(listOf("new"), bundleIds(log))
    }

    @Test
    fun `the file itself is trimmed, not only what reads return`() {
        val file = logFile()
        val log = service(file)
        repeat(UpdateLogService.MAX_ENTRIES + 3 * UpdateLogService.TRIM_INTERVAL) { log.append(check("bundle-$it")) }
        log.read()

        val lines = file.readLines().filter { it.isNotEmpty() }

        assertTrue(lines.size <= UpdateLogService.MAX_ENTRIES + UpdateLogService.TRIM_INTERVAL)
    }

    @Test
    fun `a line that cannot be read is skipped, and does not take the next one with it`() {
        val file = logFile()
        val log = service(file)
        log.append(check("before"))
        log.read()
        // A process killed in the middle of a write, then garbage and an entry of no use.
        file.appendText("""${"\n"}{"timestamp":1,"type":"CHE""")

        log.append(check("after"))
        file.appendText("\nnot json\n[1,2]\n{\"timestamp\":\"x\",\"type\":\"CHECK\"}\n{\"type\":\"CHECK\"}")

        assertEquals(listOf("before", "after"), bundleIds(log))
    }

    @Test
    fun `a file too large to be this log's is discarded`() {
        val file = logFile()
        file.parentFile!!.mkdirs()
        file.writeBytes(ByteArray((UpdateLogService.MAX_FILE_BYTES + 1).toInt()))
        val log = service(file)

        assertEquals("[]", log.read())
        assertFalse(file.exists())
        log.append(check("a"))
        assertEquals(listOf("a"), bundleIds(log))
    }

    @Test
    fun `clear removes every entry and the next append starts over`() {
        val log = service(logFile())
        log.append(check("a"))

        assertTrue(log.clear())
        assertEquals("[]", log.read())

        log.append(check("b"))
        assertEquals(listOf("b"), bundleIds(log))
        assertTrue(log.clear())
        assertTrue(log.clear())
    }

    @Test
    fun `an unwritable location never throws`() {
        val blocker = temporaryFolder.newFile()
        val log = service(File(blocker, "nested/${UpdateLogService.FILENAME}"))

        log.append(check("a"))

        assertEquals("[]", log.read())
    }

    @Test
    fun `a JavaScript entry keeps only what the log knows, stamped by native`() {
        val log = service(logFile())

        log.appendJson(
            JSONObject()
                .put("timestamp", 1)
                .put("type", "CHECK")
                .put("outcome", "UP_TO_DATE")
                .put("bundleId", "a")
                .put("secret", "value")
                .put("error", JSONObject().put("message", "m").put("headers", "x-api-key: 1"))
                .toString(),
        )

        val entry = entries(log.read()).single()
        assertEquals(now, entry.getLong("timestamp"))
        assertEquals("a", entry.getString("bundleId"))
        assertFalse(entry.has("secret"))
        assertFalse(entry.getJSONObject("error").has("headers"))
    }

    @Test
    fun `JavaScript entries of what only native records, or unreadable ones, are ignored`() {
        val log = service(logFile())

        log.appendJson("not json")
        log.appendJson("""{"type":"APPLY","outcome":"APPLIED"}""")
        log.appendJson("""{"type":"CHECK"}""")

        assertEquals("[]", log.read())
    }

    @Test
    fun `messages keep only the host of a URL`() {
        assertEquals(
            "Failed https://cdn.example.com and s3://bucket then done",
            UpdateLogService.sanitizeMessage(
                "Failed https://user:pass@cdn.example.com/a/b.zip?X-Amz-Signature=secret&token=t and s3://bucket/key?sig=1 then done",
            ),
        )
    }

    @Test
    fun `an error's message is sanitized and bounded in the file`() {
        val file = logFile()
        val log = service(file)

        log.append(
            UpdateLogEvent(
                type = UpdateLogEvent.DOWNLOAD,
                outcome = UpdateLogEvent.FAILED,
                error = JSONObject().put("message", "Invalid 'manifestUrl' provided: https://x.dev/m?token=secret " + "y".repeat(5000)),
            ),
        )
        log.read()

        val contents = file.readText()
        assertFalse(contents.contains("token=secret"))
        assertFalse(contents.contains("/m?"))
        assertTrue(entries(log.read()).single().getJSONObject("error").getString("message").length <= 512)
    }

    @Test
    fun `errorOf reads a classified failure's code and classification`() {
        val error = UpdateLogEvent.errorOf(HotUpdaterException.bundleInCrashedHistory("a"))
        assertEquals("BUNDLE_IN_CRASHED_HISTORY", error.getString("code"))
        assertTrue(error.getString("message").isNotEmpty())

        val classified = UpdateLogEvent.errorOf(HotUpdaterException.missingBundleId())
        assertEquals("MISSING_BUNDLE_ID", classified.getString("code"))
        assertEquals("download", classified.getString("stage"))
        assertEquals("invalid_response", classified.getString("reason"))
    }
}
