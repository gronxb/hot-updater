package com.hotupdater

import android.content.Context
import java.io.File
import java.util.UUID

/**
 * Owns the install id, a random id created once per app installation.
 *
 * The id lives outside the bundle store and outside device backups, so a
 * device restored from a backup gets an id of its own.
 */
class InstallIdentityService(
    private val identityFile: File,
) {
    companion object {
        /** The install id kept in `noBackupFilesDir/hot-updater/install-identity.json`. */
        fun create(context: Context): InstallIdentityService =
            InstallIdentityService(NoBackupStorage.file(context, InstallationIdentity.IDENTITY_FILENAME))
    }

    private var identity: InstallationIdentity? = null

    /**
     * Returns the install id, creating and persisting a random one when none
     * is stored. The id stays stable for this process even if persisting fails.
     */
    @Synchronized
    fun getInstallId(): String {
        identity?.let { return it.installId }
        val current =
            InstallationIdentity.loadFromFile(identityFile)
                ?: InstallationIdentity(installId = UUID.randomUUID().toString()).also { it.saveToFile(identityFile) }
        identity = current
        return current.installId
    }
}
