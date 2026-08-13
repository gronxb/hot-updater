package com.hotupdater

import android.util.Log
import androidx.core.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream

/**
 * Bundle metadata for managing stable/staging bundles and verification state
 */
data class BundleMetadata(
    val schema: String = SCHEMA_VERSION,
    val isolationKey: String? = null,
    val stableBundleId: String? = null,
    val stagingBundleId: String? = null,
    val stableSelection: PersistedSelection? = null,
    val stagingSelection: PersistedSelection? = null,
    val pendingUpdateStrategy: String? = null,
    val pendingTransition: PendingSelectionTransition? = null,
    val verificationPending: Boolean = false,
    val highestSeenCatalogs: Map<String, CatalogHighWater> = emptyMap(),
    val currentSelectionContexts: Map<String, String> = emptyMap(),
    val updatedAt: Long = System.currentTimeMillis(),
) {
    companion object {
        private const val TAG = "BundleMetadata"
        const val SCHEMA_VERSION = "metadata-v2"
        const val METADATA_FILENAME = "metadata.json"

        fun fromJson(json: JSONObject): BundleMetadata {
            val stableBundleId = json.optNullableString("stableBundleId")
            val stagingBundleId = json.optNullableString("stagingBundleId")
            val stableSelection =
                json.optJSONObject("stableSelection")?.let(PersistedSelection::fromJson)
                    ?: stableBundleId?.let(PersistedSelection::legacyBundle)
            val stagingSelection =
                json.optJSONObject("stagingSelection")?.let(PersistedSelection::fromJson)
                    ?: stagingBundleId?.let(PersistedSelection::legacyBundle)
            val highestSeenCatalogs = linkedMapOf<String, CatalogHighWater>()
            json.optJSONObject("highestSeenCatalogs")?.let { highWaters ->
                highWaters.keys().forEach { key ->
                    highWaters.optJSONObject(key)?.let { value ->
                        highestSeenCatalogs[key] = CatalogHighWater.fromJson(value)
                    }
                }
            }
            val currentSelectionContexts = linkedMapOf<String, String>()
            json.optJSONObject("currentSelectionContexts")?.let { contexts ->
                contexts.keys().forEach { key ->
                    contexts.optString(key).takeIf { it.isNotEmpty() }?.let { value ->
                        currentSelectionContexts[key] = value
                    }
                }
            }
            return BundleMetadata(
                schema = SCHEMA_VERSION,
                isolationKey =
                    if (json.has("isolationKey") && !json.isNull("isolationKey")) {
                        json.getString("isolationKey").takeIf { it.isNotEmpty() }
                    } else {
                        null
                    },
                stableBundleId = stableSelection?.bundleId ?: stableBundleId,
                stagingBundleId = stagingSelection?.bundleId ?: stagingBundleId,
                stableSelection = stableSelection,
                stagingSelection = stagingSelection,
                pendingUpdateStrategy = json.optNullableString("pendingUpdateStrategy"),
                pendingTransition =
                    json.optJSONObject("pendingTransition")?.let(PendingSelectionTransition::fromJson),
                verificationPending = json.optBoolean("verificationPending", false),
                highestSeenCatalogs = highestSeenCatalogs,
                currentSelectionContexts = currentSelectionContexts,
                updatedAt = json.optLong("updatedAt", System.currentTimeMillis()),
            )
        }

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
            put("stableSelection", stableSelection?.toJson() ?: JSONObject.NULL)
            put("stagingSelection", stagingSelection?.toJson() ?: JSONObject.NULL)
            put("pendingUpdateStrategy", pendingUpdateStrategy ?: JSONObject.NULL)
            put("pendingTransition", pendingTransition?.toJson() ?: JSONObject.NULL)
            put("verificationPending", verificationPending)
            put(
                "highestSeenCatalogs",
                JSONObject().apply {
                    highestSeenCatalogs.toSortedMap().forEach { (key, value) ->
                        put(key, value.toJson())
                    }
                },
            )
            put("currentSelectionContexts", JSONObject(currentSelectionContexts.toSortedMap()))
            put("updatedAt", updatedAt)
        }

    fun saveToFile(file: File): Boolean =
        AtomicFile(file).let { atomicFile ->
            var output: FileOutputStream? = null
            try {
            file.parentFile?.mkdirs()
            output = atomicFile.startWrite()
            output.write(toJson().toString(2).toByteArray())
            atomicFile.finishWrite(output)
            Log.d(TAG, "Saved metadata to file: ${file.absolutePath}")
            true
            } catch (e: Exception) {
            output?.let(atomicFile::failWrite)
            Log.e(TAG, "Failed to save metadata to file", e)
            false
            }
        }
}

data class CatalogHighWater(
    val generation: Long,
    val catalogHash: String,
) {
    companion object {
        fun fromJson(json: JSONObject): CatalogHighWater =
            CatalogHighWater(
                generation = json.getLong("generation"),
                catalogHash = json.getString("catalogHash"),
            )
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("generation", generation)
            put("catalogHash", catalogHash)
        }
}

data class PersistedSelection(
    val kind: String,
    val releaseId: String?,
    val bundleId: String,
    val authorityId: String?,
    val scopeKey: String?,
    val generation: Long?,
    val catalogHash: String?,
    val channel: String,
    val selectionContextHash: String?,
) {
    companion object {
        fun legacyBundle(bundleId: String): PersistedSelection =
            PersistedSelection(
                kind = "BUNDLE",
                releaseId = null,
                bundleId = bundleId,
                authorityId = null,
                scopeKey = null,
                generation = null,
                catalogHash = null,
                channel = "",
                selectionContextHash = null,
            )

        fun fromJson(json: JSONObject): PersistedSelection =
            PersistedSelection(
                kind = json.getString("kind"),
                releaseId = json.optNullableString("releaseId"),
                bundleId = json.getString("bundleId"),
                authorityId = json.optNullableString("authorityId"),
                scopeKey = json.optNullableString("scopeKey"),
                generation = if (json.has("generation") && !json.isNull("generation")) json.getLong("generation") else null,
                catalogHash = json.optNullableString("catalogHash"),
                channel = json.optString("channel", ""),
                selectionContextHash = json.optNullableString("selectionContextHash"),
            )
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("kind", kind)
            put("releaseId", releaseId ?: JSONObject.NULL)
            put("bundleId", bundleId)
            put("authorityId", authorityId ?: JSONObject.NULL)
            put("scopeKey", scopeKey ?: JSONObject.NULL)
            put("generation", generation ?: JSONObject.NULL)
            put("catalogHash", catalogHash ?: JSONObject.NULL)
            put("channel", channel)
            put("selectionContextHash", selectionContextHash ?: JSONObject.NULL)
        }

    fun toMap(): Map<String, Any?> =
        mapOf(
            "kind" to kind,
            "releaseId" to releaseId,
            "bundleId" to bundleId,
            "authorityId" to authorityId,
            "scopeKey" to scopeKey,
            "generation" to generation?.toDouble(),
            "catalogHash" to catalogHash,
            "channel" to channel,
            "selectionContextHash" to selectionContextHash,
        )
}

data class PendingSelectionTransition(
    val fromReleaseId: String?,
    val fromBundleId: String,
    val toReleaseId: String?,
    val toBundleId: String,
) {
    companion object {
        fun fromJson(json: JSONObject): PendingSelectionTransition =
            PendingSelectionTransition(
                fromReleaseId = json.optNullableString("fromReleaseId"),
                fromBundleId = json.getString("fromBundleId"),
                toReleaseId = json.optNullableString("toReleaseId"),
                toBundleId = json.getString("toBundleId"),
            )
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("fromReleaseId", fromReleaseId ?: JSONObject.NULL)
            put("fromBundleId", fromBundleId)
            put("toReleaseId", toReleaseId ?: JSONObject.NULL)
            put("toBundleId", toBundleId)
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

data class PendingCrashRecovery(
    val launchedBundleId: String?,
    val shouldRollback: Boolean,
) {
    companion object {
        fun fromJson(json: JSONObject): PendingCrashRecovery =
            PendingCrashRecovery(
                launchedBundleId =
                    if (json.has("bundleId") && !json.isNull("bundleId")) {
                        json.getString("bundleId").takeIf { it.isNotEmpty() }
                    } else {
                        null
                    },
                shouldRollback = json.optBoolean("shouldRollback", false),
            )
    }
}

data class LaunchSelection(
    val bundleUrl: String,
    val launchedBundleId: String?,
    val shouldRollbackOnCrash: Boolean,
)

data class LaunchReport(
    val status: String = "UNCHANGED",
    val fromReleaseId: String? = null,
    val fromBundleId: String? = null,
    val toReleaseId: String? = null,
    val toBundleId: String? = null,
    val updateStrategy: String? = null,
) {
    companion object {
        private const val TAG = "LaunchReport"
        const val LAUNCH_REPORT_FILENAME = "launch-report.json"

        fun fromJson(json: JSONObject): LaunchReport =
            LaunchReport(
                status = json.optString("status", "UNCHANGED"),
                fromReleaseId = json.optNullableString("fromReleaseId"),
                fromBundleId = json.optNullableString("fromBundleId"),
                toReleaseId = json.optNullableString("toReleaseId"),
                toBundleId = json.optNullableString("toBundleId"),
                updateStrategy = json.optNullableString("updateStrategy"),
            )

        fun loadFromFile(file: File): LaunchReport? =
            try {
                if (!file.exists()) {
                    null
                } else {
                    fromJson(JSONObject(file.readText()))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load launch report", e)
                null
            }
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("status", status)
            put("fromReleaseId", fromReleaseId ?: JSONObject.NULL)
            put("fromBundleId", fromBundleId ?: JSONObject.NULL)
            put("toReleaseId", toReleaseId ?: JSONObject.NULL)
            put("toBundleId", toBundleId ?: JSONObject.NULL)
            put("updateStrategy", updateStrategy ?: JSONObject.NULL)
        }

    fun saveToFile(file: File): Boolean =
        try {
            file.parentFile?.mkdirs()
            file.writeText(toJson().toString(2))
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save launch report", e)
            false
        }
}

data class InstallationIdentity(
    val installId: String,
    val userId: String? = null,
    val username: String? = null,
) {
    companion object {
        private const val TAG = "InstallationIdentity"
        const val IDENTITY_FILENAME = "identity.json"

        fun fromJson(json: JSONObject): InstallationIdentity =
            InstallationIdentity(
                installId = json.getString("installId"),
                userId = json.optNullableString("userId"),
                username = json.optNullableString("username"),
            )

        fun loadFromFile(file: File): InstallationIdentity? =
            try {
                AtomicFile(file).openRead().bufferedReader().use { reader ->
                    fromJson(JSONObject(reader.readText()))
                }
            } catch (_: FileNotFoundException) {
                null
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load installation identity", e)
                null
            }
    }

    fun toJson(): JSONObject =
        JSONObject().apply {
            put("installId", installId)
            put("userId", userId ?: JSONObject.NULL)
            put("username", username ?: JSONObject.NULL)
        }

    fun saveToFile(file: File): Boolean =
        AtomicFile(file).let { atomicFile ->
            var output: FileOutputStream? = null
            try {
                file.parentFile?.mkdirs()
                output = atomicFile.startWrite()
                output.write(toJson().toString(2).toByteArray())
                atomicFile.finishWrite(output)
                true
            } catch (e: Exception) {
                output?.let(atomicFile::failWrite)
                Log.e(TAG, "Failed to save installation identity", e)
                false
            }
        }
}

private fun JSONObject.optNullableString(key: String): String? =
    if (has(key) && !isNull(key)) {
        getString(key).takeIf { it.isNotEmpty() }
    } else {
        null
    }
