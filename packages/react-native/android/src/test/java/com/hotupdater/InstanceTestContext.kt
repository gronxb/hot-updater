package com.hotupdater

import android.content.ContentResolver
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import java.io.File

/**
 * An application context whose files, no-backup, and data directories are
 * test directories. It has no package manager or manifest, so configuration
 * comes from [HotUpdaterConfig] and the app version reads as unknown. Shared
 * preferences live in memory, by name.
 */
internal class InstanceTestContext(
    root: File,
) : ContextWrapper(null) {
    private val filesDirectory = File(root, "files").apply { mkdirs() }
    private val noBackupDirectory = File(root, "no_backup").apply { mkdirs() }
    private val dataDirectory = File(root, "data").apply { mkdirs() }
    private val preferences = HashMap<String, MemorySharedPreferences>()

    /** Where Android keeps shared preferences files, which the preferences sweep reads. */
    val sharedPrefsDir: File = File(dataDirectory, "shared_prefs").apply { mkdirs() }

    override fun getApplicationContext(): Context = this

    override fun getPackageName(): String = "com.example.app"

    /** No `ANDROID_ID`: settings read as unset, as on a device without one. */
    override fun getContentResolver(): ContentResolver? = null

    override fun getFilesDir(): File = filesDirectory

    override fun getNoBackupFilesDir(): File = noBackupDirectory

    override fun getApplicationInfo(): ApplicationInfo = ApplicationInfo().apply { dataDir = dataDirectory.path }

    override fun getSharedPreferences(
        name: String,
        mode: Int,
    ): SharedPreferences = synchronized(preferences) { preferences.getOrPut(name) { MemorySharedPreferences() } }

    private class MemorySharedPreferences : SharedPreferences {
        private val values = HashMap<String, Any?>()

        override fun getAll(): Map<String, *> = synchronized(values) { HashMap(values) }

        override fun getString(
            key: String,
            defValue: String?,
        ): String? = synchronized(values) { values[key] as? String ?: defValue }

        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(
            key: String,
            defValues: MutableSet<String>?,
        ): MutableSet<String>? = synchronized(values) { values[key] as? MutableSet<String> ?: defValues }

        override fun getInt(
            key: String,
            defValue: Int,
        ): Int = synchronized(values) { values[key] as? Int ?: defValue }

        override fun getLong(
            key: String,
            defValue: Long,
        ): Long = synchronized(values) { values[key] as? Long ?: defValue }

        override fun getFloat(
            key: String,
            defValue: Float,
        ): Float = synchronized(values) { values[key] as? Float ?: defValue }

        override fun getBoolean(
            key: String,
            defValue: Boolean,
        ): Boolean = synchronized(values) { values[key] as? Boolean ?: defValue }

        override fun contains(key: String): Boolean = synchronized(values) { values.containsKey(key) }

        override fun edit(): SharedPreferences.Editor = Editor()

        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit

        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) = Unit

        private inner class Editor : SharedPreferences.Editor {
            private val changes = HashMap<String, Any?>()
            private var clears = false

            override fun putString(
                key: String,
                value: String?,
            ) = apply { changes[key] = value }

            override fun putStringSet(
                key: String,
                values: MutableSet<String>?,
            ) = apply { changes[key] = values }

            override fun putInt(
                key: String,
                value: Int,
            ) = apply { changes[key] = value }

            override fun putLong(
                key: String,
                value: Long,
            ) = apply { changes[key] = value }

            override fun putFloat(
                key: String,
                value: Float,
            ) = apply { changes[key] = value }

            override fun putBoolean(
                key: String,
                value: Boolean,
            ) = apply { changes[key] = value }

            override fun remove(key: String) = apply { changes[key] = null }

            override fun clear() = apply { clears = true }

            override fun commit(): Boolean {
                synchronized(values) {
                    if (clears) values.clear()
                    changes.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
                }
                return true
            }

            override fun apply() {
                commit()
            }
        }
    }
}
