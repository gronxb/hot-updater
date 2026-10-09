package com.hotupdater.lynx

import com.hotupdater.lynx.internal.LynxBackgroundScript
import java.util.UUID

/** Native receipt and detached script bytes; no foreground launch authority. */
internal class LynxBackgroundSnapshot private constructor(
    val selection: CatalogPolicy.Receipt,
    val manifestHash: String,
    val entry: String,
    val source: String,
) {
    val taskId: String = UUID.randomUUID().toString()

    companion object {
        fun copy(selection: CatalogPolicy.Receipt, files: VerifiedLynxInstallation): LynxBackgroundSnapshot {
            val entry = checkNotNull(files.backgroundEntry) { "The selected Lynx artifact has no background entry" }
            val source = LynxBackgroundScript.read(files.directory, entry, files.managedFileHashes.getValue(entry))
            return LynxBackgroundSnapshot(selection, files.manifestHash, entry, source)
        }
    }
}
