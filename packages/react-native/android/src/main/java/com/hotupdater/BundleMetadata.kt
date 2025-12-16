package com.hotupdater

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Bundle metadata for managing stable/staging bundles and verification state
 */
data class BundleMetadata(
    val schema: String = SCHEMA_VERSION,
    val isolationKey: String? = null,
    val stableBundleId: String? = null,
    val stagingBundleId: String? = null,
    val verificationPending: Boolean = false,
    val verificationAttemptedAt: Long? = null,
    val stagingExecutionCount: Int? = null,
    val updatedAt: Long = System.currentTimeMillis(),
) {
    companion object {
        private const val TAG = "BundleMetadata"
        const val SCHEMA_VERSION = "metadata-v1"
        const val METADATA_FILENAME = "metadata.json"

        fun fromJson(json: JSONObject): BundleMetadata =
            BundleMetadata(
                schema = json.optString("schema", SCHEMA_VERSION),
                isolationKey =
                    if (json.has("isolationKey") && !json.isNull("isolationKey")) {
                        json.getString("isolationKey").takeIf { it.isNotEmpty() }
                    } else {
                        null
                    },
                stableBundleId =
                    if (json.has("stableBundleId") && !json.isNull("stableBundleId")) {
                        json.getString("stableBundleId").takeIf { it.isNotEmpty() }
                    } else {
                        null
                    },
                stagingBundleId =
                    if (json.has("stagingBundleId") && !json.isNull("stagingBundleId")) {
                        json.getString("stagingBundleId").takeIf { it.isNotEmpty() }
                    } else {
                        null
                    },
                verificationPending = json.optBoolean("verificationPending", false),
                verificationAttemptedAt =
                    if (json.has("verificationAttemptedAt") && !json.isNull("verificationAttemptedAt")) {
                        json.getLong("verificationAttemptedAt")
                    } else {
                        null
                    },
                stagingExecutionCount =
                    if (json.has("stagingExecutionCount") && !json.isNull("stagingExecutionCount")) {
                        json.getInt("stagingExecutionCount")
                    } else {
                        null
                    },
                updatedAt = json.optLong("updatedAt", System.currentTimeMillis()),
            )

        fun loadFromFile(
            file: File,
            expectedIsolationKey: String,
        ): BundleMetadata? {
            return try {
                if (!file.exists()) {
                    Log.d(TAG, "Metadata file does not exist: ${file.absolutePath}")
                    return null
                }
                val jsonString = file.readText()
                val json = JSONObject(jsonString)
                val metadata = fromJson(json)

                // Validate isolation key
                val metadataKey = metadata.isolationKey
                if (metadataKey != null) {
                    if (metadataKey != expectedIsolationKey) {
                        Log.d(TAG, "Isolation key mismatch: expected=$expectedIsolationKey, got=$metadataKey")
                        return null
                    }
                } else {
                    Log.d(TAG, "Missing isolation key in metadata, treating as invalid")
                    return null
                }

                metadata
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load metadata from file", e)
                null
            }
        }
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("schema", schema)
            put("isolationKey", isolationKey ?: JSONObject.NULL)
            put("stableBundleId", stableBundleId ?: JSONObject.NULL)
            put("stagingBundleId", stagingBundleId ?: JSONObject.NULL)
            put("verificationPending", verificationPending)
            put("verificationAttemptedAt", verificationAttemptedAt ?: JSONObject.NULL)
            put("stagingExecutionCount", stagingExecutionCount ?: JSONObject.NULL)
            put("updatedAt", updatedAt)
        }

    fun saveToFile(file: File): Boolean =
        try {
            file.parentFile?.mkdirs()
            file.writeText(toJson().toString(2))
            Log.d(TAG, "Saved metadata to file: ${file.absolutePath}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save metadata to file", e)
            false
        }
}

/**
 * Entry for a crashed bundle in history
 */
data class CrashedBundleEntry(
    val bundleId: String,
    val crashedAt: Long,
    val crashCount: Int = 1,
) {
    companion object {
        fun fromJson(json: JSONObject): CrashedBundleEntry =
            CrashedBundleEntry(
                bundleId = json.getString("bundleId"),
                crashedAt = json.getLong("crashedAt"),
                crashCount = json.optInt("crashCount", 1),
            )
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("bundleId", bundleId)
            put("crashedAt", crashedAt)
            put("crashCount", crashCount)
        }
}

/**
 * History of crashed bundles
 */
data class CrashedHistory(
    val bundles: MutableList<CrashedBundleEntry> = mutableListOf(),
    val maxHistorySize: Int = DEFAULT_MAX_HISTORY_SIZE,
) {
    companion object {
        private const val TAG = "CrashedHistory"
        const val DEFAULT_MAX_HISTORY_SIZE = 10
        const val CRASHED_HISTORY_FILENAME = "crashed-history.json"

        fun fromJson(json: JSONObject): CrashedHistory {
            val bundlesArray = json.optJSONArray("bundles") ?: JSONArray()
            val bundles = mutableListOf<CrashedBundleEntry>()
            for (i in 0 until bundlesArray.length()) {
                bundles.add(CrashedBundleEntry.fromJson(bundlesArray.getJSONObject(i)))
            }
            return CrashedHistory(
                bundles = bundles,
                maxHistorySize = json.optInt("maxHistorySize", DEFAULT_MAX_HISTORY_SIZE),
            )
        }

        fun loadFromFile(file: File): CrashedHistory {
            return try {
                if (!file.exists()) {
                    Log.d(TAG, "Crashed history file does not exist, returning empty history")
                    return CrashedHistory()
                }
                val jsonString = file.readText()
                val json = JSONObject(jsonString)
                fromJson(json)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load crashed history from file", e)
                CrashedHistory()
            }
        }
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            val bundlesArray = JSONArray()
            bundles.forEach { bundlesArray.put(it.toJson()) }
            put("bundles", bundlesArray)
            put("maxHistorySize", maxHistorySize)
        }

    fun saveToFile(file: File): Boolean =
        try {
            file.parentFile?.mkdirs()
            file.writeText(toJson().toString(2))
            Log.d(TAG, "Saved crashed history to file: ${file.absolutePath}")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save crashed history to file", e)
            false
        }

    fun contains(bundleId: String): Boolean = bundles.any { it.bundleId == bundleId }

    fun addEntry(bundleId: String) {
        val existingIndex = bundles.indexOfFirst { it.bundleId == bundleId }
        if (existingIndex >= 0) {
            // Update existing entry
            val existing = bundles[existingIndex]
            bundles[existingIndex] =
                existing.copy(
                    crashedAt = System.currentTimeMillis(),
                    crashCount = existing.crashCount + 1,
                )
        } else {
            // Add new entry
            bundles.add(
                CrashedBundleEntry(
                    bundleId = bundleId,
                    crashedAt = System.currentTimeMillis(),
                    crashCount = 1,
                ),
            )
        }

        // Trim to max size (keep most recent)
        if (bundles.size > maxHistorySize) {
            bundles.sortBy { it.crashedAt }
            while (bundles.size > maxHistorySize) {
                bundles.removeAt(0)
            }
        }
    }

    fun clear() {
        bundles.clear()
    }
}
