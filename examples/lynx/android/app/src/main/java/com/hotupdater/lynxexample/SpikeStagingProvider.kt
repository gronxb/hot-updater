package com.hotupdater.lynxexample

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File

/** Shell-only G1 manual placement. Never included in the production SDK. */
class SpikeStagingProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri) = "application/octet-stream"
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        require(mode == "w") { "Staging provider only accepts writes" }
        val segments = uri.pathSegments
        require(segments.size >= 3 && segments.none { it.isEmpty() || it == "." || it == ".." || it.contains('/') || it.contains('\\') }) { "Invalid staging path" }
        require(segments[0] in listOf("react", "vue", "octane")) { "Invalid framework" }
        val root = File(requireNotNull(context).filesDir, "staged").canonicalFile
        val target = File(root, segments.joinToString("/")).canonicalFile
        require(target.path.startsWith(root.path + "/")) { "Path outside staging directory" }
        target.parentFile!!.mkdirs()
        return ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_WRITE_ONLY)
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
