package com.hotupdater

/**
 * The crash marker as this process found it, before settling consumed it. A
 * crash writes one. A launch the system killed, or a person left, doesn't.
 */
internal data class HotUpdaterSandboxCrashMarker(
    /** The built-in bundle's ID when the marker names no bundle. */
    val bundleId: String,
    val shouldRollback: Boolean,
)

/** The rollback the SDK's launch report states, the only proof that one happened. */
internal data class HotUpdaterSandboxRollback(
    val fromBundleId: String,
    val toBundleId: String,
)

internal data class HotUpdaterSandboxLaunchEvidence(
    val marker: HotUpdaterSandboxCrashMarker? = null,
    val rollback: HotUpdaterSandboxRollback? = null,
)

/**
 * What the last launch left: from the settled transition and the resulting
 * selection, never from a change in the crash history's IDs.
 */
internal data class HotUpdaterSandboxLastLaunch(
    val kind: Kind,
    val bundleId: String,
    /** Where a rollback went, only when one happened. */
    val rolledBackToBundleId: String?,
) {
    enum class Kind {
        /** It crashed before first content, and the device rolled back. */
        CRASHED_BEFORE_CONTENT,

        /**
         * It ended before first content with no crash: the device rolled back,
         * and the cause is unknown. A person left, or the app hung.
         */
        ENDED_BEFORE_CONTENT,

        /** It crashed and nothing rolled back, such as after first content verified it. A verified bundle stays selected. */
        CRASHED,
    }

    companion object {
        fun derive(
            evidence: HotUpdaterSandboxLaunchEvidence,
            launchBundleId: String?,
        ): HotUpdaterSandboxLastLaunch? {
            val rollback = evidence.rollback
            // A rollback is claimed only when the report and what this launch runs agree.
            if (rollback != null && rollback.toBundleId == launchBundleId) {
                return HotUpdaterSandboxLastLaunch(
                    kind =
                        if (evidence.marker?.bundleId == rollback.fromBundleId) {
                            Kind.CRASHED_BEFORE_CONTENT
                        } else {
                            Kind.ENDED_BEFORE_CONTENT
                        },
                    bundleId = rollback.fromBundleId,
                    rolledBackToBundleId = rollback.toBundleId,
                )
            }
            val marker = evidence.marker ?: return null
            return HotUpdaterSandboxLastLaunch(Kind.CRASHED, marker.bundleId, null)
        }
    }
}
