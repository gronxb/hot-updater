package com.hotupdater.lynx

import android.content.Context
import android.os.Process
import com.hotupdater.lynx.internal.ArchiveIntegrity
import com.hotupdater.lynx.internal.HashUtils
import java.io.File
import java.lang.ref.WeakReference

internal fun lynxScopeDirectory(
    filesDir: File,
    binaryId: String,
    embedded: VerifiedLynxInstallation,
    configuration: LynxHostConfiguration,
): File {
    val keyIdentity = ArchiveIntegrity(configuration.publicKeyPem).keyIdentity
    val namespace = digestString(listOf(binaryId, configuration.runtimeId, configuration.channel,
        configuration.appVersion, embedded.bundleId, embedded.manifestHash, keyIdentity).joinToString("\n"))
    return File(filesDir, "hot-updater-lynx/scopes/$namespace").canonicalFile
}

/** Serializes foreground ownership and detached background snapshots for one native scope. */
class LynxRuntimeHost internal constructor(
    private val filesDir: File,
    private val packageCodePath: File,
    private val embedded: VerifiedLynxInstallation,
    val configuration: LynxHostConfiguration,
    private val processIdentity: () -> String = { Process.myPid().toString() },
    private val processToken: String = LynxUpdaterController.PROCESS_TOKEN,
    private val binaryId: String = HashUtils.calculateSHA256(packageCodePath),
) {
    private val directory = lynxScopeDirectory(filesDir, binaryId, embedded, configuration)
    private val ownerLock = Any()
    private var foreground: LynxUpdaterController? = null

    fun createForeground(): LynxUpdaterController = synchronized(ownerLock) {
        check(foreground == null) { "This Lynx scope already has a foreground owner" }
        LynxUpdaterController(filesDir, packageCodePath, embedded, configuration, processIdentity, processToken,
            runtimeHost = this, binaryId = binaryId).also { foreground = it }
    }

    internal fun closeForeground(controller: LynxUpdaterController) = synchronized(ownerLock) {
        check(controller.runtimeHost === this) { "A different Lynx host owns this controller" }
        try {
            controller.closeOwned()
        } finally {
            if (foreground === controller) foreground = null
        }
    }

    internal fun backgroundSnapshot(): LynxBackgroundSnapshot = synchronized(ownerLock) {
        foreground?.let { return@synchronized it.backgroundSnapshot() }
        val store = LynxStateStore(directory, readOnly = true)
        try {
            val selected = LynxStoredSelectionReader(store.value, directory, embedded, configuration, binaryId)
                .backgroundSelection(processToken, cold = true)
            LynxBackgroundSnapshot.copy(selected.first, selected.second)
        } finally { store.close() }
    }

    companion object {
        private val hosts = mutableMapOf<String, WeakReference<LynxRuntimeHost>>()

        /** Supply the same native configuration from foreground and OS task entry points. */
        @JvmStatic fun get(context: Context, configuration: LynxHostConfiguration): LynxRuntimeHost {
            val app = context.applicationContext
            val binaryId = HashUtils.calculateSHA256(File(app.packageCodePath))
            val embedded = loadEmbedded(app, configuration)
            val directory = lynxScopeDirectory(app.filesDir, binaryId, embedded, configuration)
            synchronized(hosts) {
                hosts.entries.removeAll { it.value.get() == null }
                hosts[directory.path]?.get()?.let {
                    check(it.configuration == configuration) { "Native configuration changed for an owned Lynx scope" }
                    return it
                }
                return LynxRuntimeHost(app.filesDir, File(app.packageCodePath), embedded, configuration, binaryId = binaryId).also {
                    hosts[directory.path] = WeakReference(it)
                }
            }
        }
    }
}
