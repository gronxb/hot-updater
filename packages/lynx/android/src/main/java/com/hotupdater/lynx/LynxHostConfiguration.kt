package com.hotupdater.lynx

import android.content.Context
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.DurableFiles
import com.hotupdater.lynx.internal.LynxArtifactVerifier
import com.hotupdater.lynx.internal.ManagedPaths
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** All scope, compatibility and embedded identities originate in native application code. */
data class LynxHostConfiguration(
    val runtimeId: String,
    val channel: String,
    val appVersion: String,
    val embeddedAssetDirectory: String,
    val cohort: String,
    val publicKeyPem: String? = null,
    val fingerprintHash: String? = null,
)

internal fun digestString(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

internal fun loadEmbedded(context: Context, config: LynxHostConfiguration): VerifiedLynxInstallation {
    val configured = File(config.embeddedAssetDirectory)
    val overlay = when {
        configured.isAbsolute && configured.isDirectory -> configured
        File(context.filesDir, configured.name).isDirectory -> File(context.filesDir, configured.name)
        else -> configured
    }
    if (overlay.isAbsolute && overlay.isDirectory) {
        val manifestFile = File(overlay, "manifest.json")
        val nativeManifest = JSONObject(String(manifestFile.readBytes()))
        val bundle = nativeManifest.getString("bundleId")
        val request = LynxArtifactRequest(bundle, "native-embedded", "native-embedded")
        return LynxArtifactVerifier(
            LynxInstallConfiguration(config.runtimeId),
            ArchiveIntegrity(null),
        ).verify(overlay.canonicalFile, request)
    }
    val manifestBytes = context.assets.open("${config.embeddedAssetDirectory}/manifest.json").use { it.readBytes() }
    val nativeManifest = JSONObject(String(manifestBytes))
    val bundle = nativeManifest.getString("bundleId")
    val digest = MessageDigest.getInstance("SHA-256").digest(manifestBytes).joinToString("") { "%02x".format(it) }
    val root = File(context.filesDir, "hot-updater-lynx/embedded/$digest").canonicalFile
    synchronized(embeddedLock) {
        if (!root.exists()) {
            val staging = File(root.parentFile, "$digest.tmp")
            staging.deleteRecursively(); DurableFiles.directory(staging)
            val paths = nativeManifest.getJSONObject("assets").keys().asSequence().toSet() + "manifest.json"
            try {
                paths.forEach { path ->
                    val target = ManagedPaths.resolve(staging, path)
                    DurableFiles.directory(target.parentFile!!)
                    context.assets.open("${config.embeddedAssetDirectory}/$path").use { input ->
                        FileOutputStream(target).use { output -> input.copyTo(output); output.fd.sync() }
                    }
                }
                staging.walkBottomUp().filter { it.isDirectory }.forEach(DurableFiles::syncDirectory)
                check(staging.renameTo(root)) { "Could not publish native embedded files" }
                DurableFiles.syncDirectory(root.parentFile!!)
            } finally { staging.deleteRecursively() }
        }
        // The APK is the embedded trust anchor. OTA signing policy applies to downloads.
        val request = LynxArtifactRequest(bundle, "native-embedded", "native-embedded", digest)
        return LynxArtifactVerifier(LynxInstallConfiguration(config.runtimeId), ArchiveIntegrity(null)).verify(root, request)
    }
}
private val embeddedLock = Any()
