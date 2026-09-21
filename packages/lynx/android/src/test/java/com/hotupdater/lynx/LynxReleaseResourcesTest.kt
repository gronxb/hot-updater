package com.hotupdater.lynx

import android.graphics.Typeface
import com.hotupdater.lynx.internal.HashUtils
import com.lynx.tasm.LynxBackgroundRuntimeOptions
import com.lynx.tasm.LynxBooleanOption
import com.lynx.tasm.LynxViewBuilder
import com.lynx.tasm.behavior.LynxContext
import com.lynx.tasm.fontface.FontFace
import com.lynx.tasm.fontface.FontFaceManager
import com.lynx.tasm.group.ILynxViewGroup
import com.lynx.tasm.loader.LynxFontFaceLoader
import com.lynx.tasm.provider.LynxProviderRegistry
import com.lynx.tasm.provider.LynxResourceCallback
import com.lynx.tasm.provider.LynxResourceProvider
import com.lynx.tasm.provider.LynxResourceRequest
import com.lynx.tasm.provider.LynxResourceResponse
import com.lynx.tasm.resourceprovider.LynxResourceRequest.LynxResourceType
import com.lynx.tasm.resourceprovider.generic.LynxGenericResourceFetcher
import com.lynx.tasm.resourceprovider.media.LynxMediaResourceFetcher
import com.lynx.tasm.resourceprovider.template.LynxTemplateResourceFetcher
import com.lynx.tasm.resourceprovider.template.TemplateProviderResult
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LynxReleaseResourcesTest {
    @Test
    fun coldProcessCleanupRemovesOrphansOnlyOnceForSnapshotParent() {
        val parent = Files.createTempDirectory("lynx-resource-orphans-").toFile()
        try {
            parent.resolve("stale/image.png").apply {
                parentFile.mkdirs()
                writeText("stale")
            }

            LynxReleaseResources.cleanOrphanedSnapshots(parent)
            assertFalse(parent.exists())

            parent.resolve("live/image.png").apply {
                parentFile.mkdirs()
                writeText("live")
            }
            LynxReleaseResources.cleanOrphanedSnapshots(parent)
            assertTrue(parent.resolve("live/image.png").isFile)
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun builderUsesTypedProvidersWithoutCustomImagePaths() {
        withResources(emptyMap()) { resources, _ ->
            val builder = LynxViewBuilder()
            val hostFontLoader = object : LynxFontFaceLoader.Loader() {
                override fun onLoadFontFace(
                    context: LynxContext,
                    type: FontFace.TYPE,
                    src: String,
                ): Typeface? = null
            }
            builder.setFontLoader(hostFontLoader)

            resources.configureBuilder(builder)

            assertSame(LynxBooleanOption.TRUE, builder.isEnableGenericResourceFetcher)
            assertSame(resources.generic, builder.lynxGenericResourceFetcher)
            assertSame(resources.media, builder.lynxMediaResourceFetcher)
            assertNull(field(builder, "imageFetcher"))
            assertSame(resources.template, builder.lynxTemplateResourceFetcher)
            assertSame(hostFontLoader, field(builder, "fontLoader"))
            assertSame(
                resources.externalScript,
                builder.lynxRuntimeOptions.getResourceProvidersByKey(
                    LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
                ),
            )
            assertSame(
                resources.fontPath,
                builder.lynxRuntimeOptions.getResourceProvidersByKey(
                    LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
                ),
            )
            assertNull(
                builder.lynxRuntimeOptions.getResourceProvidersByKey(
                    LynxProviderRegistry.LYNX_PROVIDER_TYPE_IMAGE,
                ),
            )
        }
    }

    @Test
    fun repeatedConfigurationPreservesExplicitHostDelegates() {
        assertRepeatedConfiguration(crossRelease = false)
    }

    @Test
    fun crossReleaseBuilderReusePreservesInheritedHostDelegates() {
        assertRepeatedConfiguration(crossRelease = true)
    }

    @Test
    fun typedProvidersPassUnmanagedRequestsToHostFetcher() {
        withResources(emptyMap()) { resources, _ ->
            val requested = mutableListOf<Pair<String, LynxResourceType>>()
            resources.unmanagedGeneric = object : LynxGenericResourceFetcher() {
                override fun fetchResource(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                    callback: com.lynx.tasm.resourceprovider.LynxResourceCallback<ByteArray>,
                ) {
                    requested += request.url to request.resourceType
                    callback.onResponse(
                        com.lynx.tasm.resourceprovider.LynxResourceResponse.onSuccess(
                            byteArrayOf(4, 5, 6),
                        ),
                    )
                }

                override fun fetchResourcePath(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                    callback: com.lynx.tasm.resourceprovider.LynxResourceCallback<String>,
                ) {
                    requested += request.url to request.resourceType
                    callback.onResponse(
                        com.lynx.tasm.resourceprovider.LynxResourceResponse.onSuccess(
                            "file:///host/font.ttf",
                        ),
                    )
                }
            }
            var font: LynxResourceResponse<String>? = null
            var script: LynxResourceResponse<ByteArray>? = null

            resources.fontPath.request(
                LynxResourceRequest("https://example.test/font.ttf"),
                responseCallback { font = it },
            )
            resources.externalScript.request(
                LynxResourceRequest("https://example.test/script.js"),
                responseCallback { script = it },
            )

            assertEquals("file:///host/font.ttf", checkNotNull(font).data)
            assertArrayEquals(byteArrayOf(4, 5, 6), checkNotNull(script).data)
            assertEquals(
                listOf(
                    "https://example.test/font.ttf" to
                        LynxResourceType.LynxResourceTypeFont,
                    "https://example.test/script.js" to
                        LynxResourceType.LynxResourceTypeExternalJSSource,
                ),
                requested,
            )
        }
    }

    @Test
    fun typedHostProvidersReceiveUnmanagedRequestsUnchanged() {
        withResources(emptyMap()) { resources, _ ->
            val builder = LynxViewBuilder()
            var fontRequest: LynxResourceRequest<Any>? = null
            var scriptRequest: LynxResourceRequest<Any>? = null
            val font = object : com.lynx.tasm.provider.LynxResourceProvider<Any, String>() {
                override fun request(
                    request: LynxResourceRequest<Any>,
                    callback: LynxResourceCallback<String>,
                ) {
                    fontRequest = request
                    callback.onResponse(LynxResourceResponse.success("host-font"))
                }
            }
            val script = object :
                com.lynx.tasm.provider.LynxResourceProvider<Any, ByteArray>() {
                override fun request(
                    request: LynxResourceRequest<Any>,
                    callback: LynxResourceCallback<ByteArray>,
                ) {
                    scriptRequest = request
                    callback.onResponse(
                        LynxResourceResponse.success(byteArrayOf(7)),
                    )
                }
            }
            builder.setResourceProvider(
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
                font,
            )
            builder.setResourceProvider(
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
                script,
            )
            resources.configureBuilder(builder)
            val originalFont = LynxResourceRequest<Any>("custom://font")
            val originalScript = LynxResourceRequest<Any>("custom://script")

            resources.fontPath.request(originalFont, responseCallback {})
            resources.externalScript.request(originalScript, responseCallback {})

            assertSame(originalFont, fontRequest)
            assertSame(originalScript, scriptRequest)
        }
    }

    @Test
    fun pinnedFontManagerConsumesExactVerifiedFileUriFromProvider() {
        val root = Files.createTempDirectory("lynx-resource-font-").toFile()
        try {
            val file = root.resolve("assets/probe.ttf").apply {
                parentFile.mkdirs()
                writeBytes(byteArrayOf(1, 2, 3, 4))
            }
            val resources = resources(
                root,
                mapOf("assets/probe.ttf" to HashUtils.calculateSHA256(file)),
            )
            val events = mutableListOf<String>()
            resources.onLoaded = { event, path, _ -> events += "$event:$path" }

            val getPath = FontFaceManager::class.java.getDeclaredMethod(
                "getPathFromFontResourceProvider",
                LynxResourceProvider::class.java,
                LynxContext::class.java,
                FontFace.TYPE::class.java,
                String::class.java,
            ).also { it.isAccessible = true }
            val result = checkNotNull(
                getPath.invoke(
                    FontFaceManager.getInstance(),
                    resources.fontPath,
                    null,
                    FontFace.TYPE.URL,
                    "hot-updater:///assets/probe.ttf",
                ) as String?,
            )

            assertTrue(result.startsWith("file:///"))
            val snapshot = File(java.net.URI(result))
            assertTrue(snapshot.isFile)
            assertTrue(snapshot.canonicalFile != file.canonicalFile)
            assertEquals(file.readBytes().toList(), snapshot.readBytes().toList())
            assertEquals(listOf("fontLoaded:assets/probe.ttf"), events)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun externalScriptAndDynamicTemplateComeFromTheBoundRelease() {
        val root = Files.createTempDirectory("lynx-resource-members-").toFile()
        try {
            val scriptBytes = "release-script".toByteArray()
            val componentBytes = "release-component".toByteArray()
            val script = root.resolve("assets/bootstrap.js").apply {
                parentFile.mkdirs()
                writeBytes(scriptBytes)
            }
            val component = root.resolve("dynamic/component.lynx.bundle").apply {
                parentFile.mkdirs()
                writeBytes(componentBytes)
            }
            val resources = resources(
                root,
                mapOf(
                    "assets/bootstrap.js" to HashUtils.calculateSHA256(script),
                    "dynamic/component.lynx.bundle" to
                        HashUtils.calculateSHA256(component),
                ),
            )
            val loaded = mutableListOf<String>()
            var scriptResult: LynxResourceResponse<ByteArray>? = null
            var templateResult:
                com.lynx.tasm.resourceprovider.LynxResourceResponse<TemplateProviderResult>? = null
            resources.onLoaded = { _, path, _ -> loaded += path }
            val builder = LynxViewBuilder()
            resources.configureBuilder(builder)

            assertSame(LynxBooleanOption.TRUE, builder.isEnableGenericResourceFetcher)
            assertSame(resources.template, builder.lynxTemplateResourceFetcher)
            assertSame(resources.generic, builder.lynxGenericResourceFetcher)
            assertSame(resources.media, builder.lynxMediaResourceFetcher)

            resources.externalScript.request(
                LynxResourceRequest("hot-updater:///assets/bootstrap.js"),
                responseCallback { scriptResult = it },
            )
            checkNotNull(builder.lynxTemplateResourceFetcher).fetchTemplate(
                com.lynx.tasm.resourceprovider.LynxResourceRequest(
                    "hot-updater:///dynamic/component.lynx.bundle",
                    LynxResourceType.LynxResourceTypeDynamicComponent,
                ),
                object :
                    com.lynx.tasm.resourceprovider.LynxResourceCallback<TemplateProviderResult> {
                    override fun onResponse(
                        response: com.lynx.tasm.resourceprovider
                            .LynxResourceResponse<TemplateProviderResult>,
                    ) {
                        templateResult = response
                    }
                },
            )

            assertArrayEquals(scriptBytes, checkNotNull(scriptResult).data)
            assertEquals(
                com.lynx.tasm.resourceprovider.LynxResourceResponse.ResponseState.SUCCESS,
                checkNotNull(templateResult).state,
            )
            assertArrayEquals(
                componentBytes,
                checkNotNull(templateResult).data.templateBinary,
            )
            assertEquals(
                listOf(
                    "assets/bootstrap.js",
                    "dynamic/component.lynx.bundle",
                ),
                loaded,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun byteHandoffRejectsChangedInstalledFile() {
        val root = Files.createTempDirectory("lynx-resource-bytes-").toFile()
        try {
            val file = root.resolve("main.lynx.bundle").apply {
                writeText("verified entry")
            }
            val expected = file.readBytes()
            val resources = resources(
                root,
                mapOf("main.lynx.bundle" to HashUtils.calculateSHA256(file)),
            )
            var delivered: ByteArray? = null
            resources.loadBytes("hot-updater:///main.lynx.bundle") {
                delivered = it
            }
            assertArrayEquals(expected, delivered)

            file.writeText("tampered entry")
            delivered = null
            assertThrows(IllegalArgumentException::class.java) {
                resources.loadBytes("hot-updater:///main.lynx.bundle") {
                    delivered = it
                }
            }
            assertEquals(null, delivered)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun pathHandoffUsesVerifiedSnapshotAndRejectsChangedSource() {
        val root = Files.createTempDirectory("lynx-resource-path-").toFile()
        try {
            val file = root.resolve("assets/probe.txt").apply {
                parentFile.mkdirs()
                writeText("verified resource")
            }
            val resources = resources(
                root,
                mapOf("assets/probe.txt" to HashUtils.calculateSHA256(file)),
            )
            val snapshot = resources.resolve("hot-updater:///assets/probe.txt")
            assertTrue(snapshot.canonicalFile != file.canonicalFile)
            assertEquals("verified resource", snapshot.readText())
            val fileUrl = file.canonicalFile.toURI().toString()
            assertEquals(snapshot, resources.resolve(fileUrl))

            file.writeText("tampered resource")
            assertThrows(IllegalArgumentException::class.java) {
                resources.resolve("hot-updater:///assets/probe.txt")
            }
            assertThrows(IllegalArgumentException::class.java) {
                resources.resolve(fileUrl)
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun pathHandoffKeepsSnapshotWhenSourceIsReplacedAfterHashing() {
        val root = Files.createTempDirectory("lynx-resource-snapshot-").toFile()
        try {
            val file = root.resolve("assets/probe.txt").apply {
                parentFile.mkdirs()
                writeText("verified resource")
            }
            val resources = resources(
                root,
                mapOf("assets/probe.txt" to HashUtils.calculateSHA256(file)),
            )
            var handedPath: String? = null

            resources.loadPath("hot-updater:///assets/probe.txt") { path ->
                handedPath = path
                assertTrue(file.delete())
                file.writeText("replacement after verified hash")
                assertEquals("verified resource", File(path).readText())
            }

            assertEquals("replacement after verified hash", file.readText())
            assertEquals("verified resource", File(checkNotNull(handedPath)).readText())
            assertTrue(File(checkNotNull(handedPath)).canonicalFile != file.canonicalFile)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun byteLoadIsObservedAfterConsumerAndFinalVerification() {
        val root = Files.createTempDirectory("lynx-resource-consumer-").toFile()
        try {
            val file = root.resolve("assets/bootstrap.js").apply {
                parentFile.mkdirs()
                writeText("verified resource")
            }
            val expectedHash = HashUtils.calculateSHA256(file)
            val resources = resources(
                root,
                mapOf("assets/bootstrap.js" to expectedHash),
            )
            val events = mutableListOf<String>()
            resources.onLoaded = { _, _, _ -> events += "loaded" }

            resources.loadBytes("hot-updater:///assets/bootstrap.js") {
                events += "consumer"
            }
            assertEquals(listOf("consumer", "loaded"), events)

            assertThrows(IllegalArgumentException::class.java) {
                resources.loadBytes("hot-updater:///assets/bootstrap.js") {
                    events += "tampering-consumer"
                    file.writeText("changed during handoff")
                }
            }
            assertEquals(
                listOf("consumer", "loaded", "tampering-consumer"),
                events,
            )
            assertTrue(HashUtils.calculateSHA256(file) != expectedHash)
        } finally {
            root.deleteRecursively()
        }
    }

    private fun resources(root: File, hashes: Map<String, String>) =
        LynxReleaseResources(
            root,
            "01900000-0000-7000-8000-000000000121",
            hashes,
            root.resolve("snapshots"),
        )

    private fun withResources(
        hashes: Map<String, String>,
        block: (LynxReleaseResources, File) -> Unit,
    ) {
        val root = Files.createTempDirectory("lynx-resource-").toFile()
        try {
            block(resources(root, hashes), root)
        } finally {
            root.deleteRecursively()
        }
    }

    private fun assertRepeatedConfiguration(crossRelease: Boolean) {
        val root = Files.createTempDirectory("lynx-resource-wrappers-").toFile()
        val oldRoot = Files.createTempDirectory("lynx-resource-old-").toFile()
        try {
            val releaseBytes = "current-release".toByteArray()
            val file = root.resolve("assets/member.bin").apply {
                parentFile.mkdirs()
                writeBytes(releaseBytes)
            }
            val resources = resources(
                root,
                mapOf("assets/member.bin" to HashUtils.calculateSHA256(file)),
            )
            val callerRequests = mutableListOf<String>()
            val callerGeneric = object : LynxGenericResourceFetcher() {
                override fun fetchResource(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                    callback: com.lynx.tasm.resourceprovider.LynxResourceCallback<ByteArray>,
                ) {
                    callerRequests += "generic:${request.url}"
                    callback.onResponse(
                        com.lynx.tasm.resourceprovider.LynxResourceResponse.onSuccess(
                            "host-generic".toByteArray(),
                        ),
                    )
                }

                override fun fetchResourcePath(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                    callback: com.lynx.tasm.resourceprovider.LynxResourceCallback<String>,
                ) = Unit
            }
            val callerMedia = object : LynxMediaResourceFetcher() {
                override fun shouldRedirectUrl(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                ): String {
                    callerRequests += "media:${request.url}"
                    return "host-media"
                }
            }
            val callerTemplate = object : LynxTemplateResourceFetcher() {
                override fun fetchTemplate(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                    callback: com.lynx.tasm.resourceprovider
                        .LynxResourceCallback<TemplateProviderResult>,
                ) {
                    callerRequests += "template:${request.url}"
                    callback.onResponse(
                        com.lynx.tasm.resourceprovider.LynxResourceResponse.onSuccess(
                            TemplateProviderResult.fromBinary("host-template".toByteArray()),
                        ),
                    )
                }

                override fun fetchSSRData(
                    request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                    callback: com.lynx.tasm.resourceprovider.LynxResourceCallback<ByteArray>,
                ) = Unit
            }
            val callerExternal = object : LynxResourceProvider<Any, ByteArray>() {
                override fun request(
                    request: LynxResourceRequest<Any>,
                    callback: LynxResourceCallback<ByteArray>,
                ) {
                    callerRequests += "external:${request.url}"
                    callback.onResponse(LynxResourceResponse.success("host-script".toByteArray()))
                }
            }
            val callerFont = object : LynxResourceProvider<Any, String>() {
                override fun request(
                    request: LynxResourceRequest<Any>,
                    callback: LynxResourceCallback<String>,
                ) {
                    callerRequests += "font:${request.url}"
                    callback.onResponse(LynxResourceResponse.success("host-font"))
                }
            }
            val builder = LynxViewBuilder()
            if (crossRelease) {
                val options = LynxBackgroundRuntimeOptions().apply {
                    setGenericResourceFetcher(callerGeneric)
                    setMediaResourceFetcher(callerMedia)
                    setTemplateResourceFetcher(callerTemplate)
                    setResourceProviders(
                        LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
                        callerExternal,
                    )
                    setResourceProviders(
                        LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
                        callerFont,
                    )
                }
                val group = Proxy.newProxyInstance(
                    ILynxViewGroup::class.java.classLoader,
                    arrayOf(ILynxViewGroup::class.java),
                ) { _, method, _ ->
                    check(method.name == "getLynxRuntimeOptions")
                    options
                } as ILynxViewGroup
                builder.setLynxViewGroup(group)
                val oldFile = oldRoot.resolve("assets/member.bin").apply {
                    parentFile.mkdirs()
                    writeText("old-release")
                }
                resources(
                    oldRoot,
                    mapOf("assets/member.bin" to HashUtils.calculateSHA256(oldFile)),
                ).configureBuilder(builder)
                resources.configureBuilder(builder)
            } else {
                builder.setGenericResourceFetcher(callerGeneric)
                builder.setMediaResourceFetcher(callerMedia)
                builder.setTemplateResourceFetcher(object : LynxTemplateResourceFetcher() {
                    override fun fetchTemplate(
                        request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                        callback: com.lynx.tasm.resourceprovider
                            .LynxResourceCallback<TemplateProviderResult>,
                    ) = error("Hostile builder template must not be retained")

                    override fun fetchSSRData(
                        request: com.lynx.tasm.resourceprovider.LynxResourceRequest,
                        callback: com.lynx.tasm.resourceprovider
                            .LynxResourceCallback<ByteArray>,
                    ) = Unit
                })
                builder.setResourceProvider(
                    LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
                    callerExternal,
                )
                builder.setResourceProvider(
                    LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
                    callerFont,
                )
                resources.unmanagedGeneric = callerGeneric
                resources.unmanagedTemplate = callerTemplate
                resources.configureBuilder(builder)
                resources.configureBuilder(builder)
            }
            val loaded = mutableListOf<String>()
            var tracked = 0
            resources.onLoaded = { event, path, _ -> loaded += "$event:$path" }
            resources.resourceGate = { operation ->
                tracked += 1
                operation()
            }

            assertSame(resources.generic, builder.lynxGenericResourceFetcher)
            assertSame(resources.media, builder.lynxMediaResourceFetcher)
            assertSame(resources.template, builder.lynxTemplateResourceFetcher)
            var bytes: ByteArray? = null
            var template: TemplateProviderResult? = null
            var script: LynxResourceResponse<ByteArray>? = null
            var font: LynxResourceResponse<String>? = null
            checkNotNull(builder.lynxGenericResourceFetcher).fetchResource(
                com.lynx.tasm.resourceprovider.LynxResourceRequest(
                    "hot-updater:///assets/member.bin",
                    LynxResourceType.LynxResourceTypeExternalJSSource,
                ),
                typedResponseCallback { bytes = it.data },
            )
            val redirected = checkNotNull(builder.lynxMediaResourceFetcher)
                .shouldRedirectUrl(
                    com.lynx.tasm.resourceprovider.LynxResourceRequest(
                        "hot-updater:///assets/member.bin",
                        LynxResourceType.LynxResourceTypeImage,
                    ),
                )
            checkNotNull(builder.lynxTemplateResourceFetcher).fetchTemplate(
                com.lynx.tasm.resourceprovider.LynxResourceRequest(
                    "hot-updater:///assets/member.bin",
                    LynxResourceType.LynxResourceTypeDynamicComponent,
                ),
                typedResponseCallback { template = it.data },
            )
            configuredProvider<ByteArray>(
                builder,
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
            ).request(
                LynxResourceRequest("hot-updater:///assets/member.bin"),
                responseCallback { script = it },
            )
            configuredProvider<String>(
                builder,
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
            ).request(
                LynxResourceRequest("hot-updater:///assets/member.bin"),
                responseCallback { font = it },
            )

            assertArrayEquals(releaseBytes, bytes)
            assertArrayEquals(releaseBytes, File(java.net.URI(redirected)).readBytes())
            assertArrayEquals(releaseBytes, checkNotNull(template).templateBinary)
            assertArrayEquals(releaseBytes, checkNotNull(script).data)
            assertArrayEquals(releaseBytes, File(java.net.URI(checkNotNull(font).data)).readBytes())
            assertEquals(emptyList<String>(), callerRequests)
            assertEquals(5, tracked)
            assertEquals(
                listOf(
                    "resourceLoaded:assets/member.bin",
                    "resourceLoaded:assets/member.bin",
                    "resourceLoaded:assets/member.bin",
                    "fontLoaded:assets/member.bin",
                ),
                loaded,
            )

            val unmanaged = com.lynx.tasm.resourceprovider.LynxResourceRequest(
                "custom://caller/resource",
                LynxResourceType.LynxResourceTypeGeneric,
            )
            checkNotNull(builder.lynxGenericResourceFetcher).fetchResource(
                unmanaged,
                typedResponseCallback { bytes = it.data },
            )
            assertEquals(
                "host-media",
                checkNotNull(builder.lynxMediaResourceFetcher)
                    .shouldRedirectUrl(unmanaged),
            )
            checkNotNull(builder.lynxTemplateResourceFetcher).fetchTemplate(
                unmanaged,
                typedResponseCallback { template = it.data },
            )
            configuredProvider<ByteArray>(
                builder,
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_EXTERNAL_JS,
            ).request(
                LynxResourceRequest("custom://caller/script"),
                responseCallback { script = it },
            )
            configuredProvider<String>(
                builder,
                LynxProviderRegistry.LYNX_PROVIDER_TYPE_FONT,
            ).request(
                LynxResourceRequest("custom://caller/font"),
                responseCallback { font = it },
            )

            assertArrayEquals("host-generic".toByteArray(), bytes)
            assertArrayEquals("host-template".toByteArray(), checkNotNull(template).templateBinary)
            assertArrayEquals("host-script".toByteArray(), checkNotNull(script).data)
            assertEquals("host-font", checkNotNull(font).data)
            assertEquals(
                listOf(
                    "generic:custom://caller/resource",
                    "media:custom://caller/resource",
                    "template:custom://caller/resource",
                    "external:custom://caller/script",
                    "font:custom://caller/font",
                ),
                callerRequests,
            )
            assertEquals(5, tracked)
        } finally {
            root.deleteRecursively()
            oldRoot.deleteRecursively()
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> configuredProvider(
        builder: LynxViewBuilder,
        key: String,
    ) = builder.lynxRuntimeOptions.getResourceProvidersByKey(key)
        as LynxResourceProvider<Any, T>

    private fun <T> responseCallback(
        consume: (LynxResourceResponse<T>) -> Unit,
    ) = object : LynxResourceCallback<T>() {
        override fun onResponse(response: LynxResourceResponse<T>) = consume(response)
    }

    private fun <T> typedResponseCallback(
        consume: (com.lynx.tasm.resourceprovider.LynxResourceResponse<T>) -> Unit,
    ) = object : com.lynx.tasm.resourceprovider.LynxResourceCallback<T> {
        override fun onResponse(
            response: com.lynx.tasm.resourceprovider.LynxResourceResponse<T>,
        ) = consume(response)
    }

    private fun field(instance: Any, name: String): Any? {
        val value = instance.javaClass.getDeclaredField(name)
        value.isAccessible = true
        return value.get(instance)
    }
}
