package com.hotupdater

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

class InstallIdentityServiceTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `creates a random install id once and keeps it across instances`() {
        val identityFile = File(temporaryFolder.root, "hot-updater/install-identity.json")
        val service = InstallIdentityService(identityFile)

        val installId = service.getInstallId()

        assertEquals(installId, UUID.fromString(installId).toString())
        assertEquals(installId, service.getInstallId())
        assertEquals(installId, InstallIdentityService(identityFile).getInstallId())
        assertEquals(
            listOf("installId"),
            JSONObject(identityFile.readText()).keys().asSequence().toList(),
        )
    }

    @Test
    fun `lives under noBackupFilesDir and never reads the old bundle store identity`() {
        val noBackupDirectory = temporaryFolder.newFolder("no_backup")
        val oldIdentityJson = "{\"installId\":\"old-install-id\",\"userId\":\"user-1\",\"username\":\"alice\"}"
        val oldIdentityFile =
            File(temporaryFolder.newFolder("files"), "bundle-store/identity.json").apply {
                parentFile?.mkdirs()
                writeText(oldIdentityJson)
            }

        val installId = InstallIdentityService.create(NoBackupContext(noBackupDirectory)).getInstallId()

        assertNotEquals("old-install-id", installId)
        assertEquals(
            InstallationIdentity(installId),
            InstallationIdentity.loadFromFile(File(noBackupDirectory, "hot-updater/install-identity.json")),
        )
        assertEquals(oldIdentityJson, oldIdentityFile.readText())
    }

    @Test
    fun `every instance of the app shares one install identity`() {
        val noBackupDirectory = temporaryFolder.newFolder("shared")
        val context = NoBackupContext(noBackupDirectory)

        val installId = InstallIdentityService.create(context).getInstallId()
        // Two instances that start at once share the id the first created,
        // even before (or without) it reaching the file.
        File(noBackupDirectory, "hot-updater/install-identity.json").delete()

        assertEquals(installId, InstallIdentityService.create(context).getInstallId())
    }

    @Test
    fun `replaces an unreadable identity with a new id`() {
        val identityFile = File(temporaryFolder.root, "install-identity.json").apply { writeText("{") }

        val installId = InstallIdentityService(identityFile).getInstallId()

        assertEquals(InstallationIdentity(installId), InstallationIdentity.loadFromFile(identityFile))
    }

    @Test
    fun `keeps the install id for the process after its file becomes unreadable`() {
        val identityFile = File(temporaryFolder.root, "install-identity.json")
        val service = InstallIdentityService(identityFile)
        val installId = service.getInstallId()

        identityFile.writeText("{")

        assertEquals(installId, service.getInstallId())
    }
}
