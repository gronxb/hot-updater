package com.hotupdater

import android.content.Context
import android.util.Log

private const val CONFIGURE_DEPRECATION =
    "Pass channel, fingerprintHash, and publicKey to HotUpdaterOptions. " +
        "Fingerprint downloads now survive native releases that ship the same artifact."

/**
 * Main's configuration: what [HotUpdaterOptions] of the `main` instance and the
 * deprecated `HotUpdater.configure` set. Set values take priority over
 * manifest metadata. Named instances never read it.
 */
object HotUpdaterConfig {
    // The values themselves. Main's options record theirs here directly;
    // every legacy write goes through the setters below. Each write takes
    // MainInstanceConfiguration.shared's lock, which main's impl reads its
    // values under.
    @Volatile
    internal var recordedFingerprintHash: String? = null

    @Volatile
    internal var recordedPublicKey: String? = null

    @Volatile
    internal var recordedChannel: String? = null

    @Volatile
    internal var recordedIsolationKey: String? = null

    /**
     * The fingerprint this build embedded, written by the
     * generateHotUpdaterFingerprintHash build task, or null for an app
     * without one.
     */
    @Volatile
    internal var buildFingerprintHash: String? = HotUpdaterBuildFingerprintHash.get().takeIf { it.isNotEmpty() }

    /** Warns when it replaces a value main's [HotUpdaterOptions] set, as [configure] does. */
    var fingerprintHash: String?
        get() = recordedFingerprintHash

        @Deprecated(CONFIGURE_DEPRECATION)
        set(value) {
            legacyWrite("HotUpdaterConfig.fingerprintHash", mapOf("fingerprintHash" to value)) { recordedFingerprintHash = value }
        }

    /** Warns when it replaces a value main's [HotUpdaterOptions] set, as [configure] does. */
    var publicKey: String?
        get() = recordedPublicKey

        @Deprecated(CONFIGURE_DEPRECATION)
        set(value) {
            legacyWrite("HotUpdaterConfig.publicKey", mapOf("publicKey" to value)) { recordedPublicKey = value }
        }

    /** Warns when it replaces a value main's [HotUpdaterOptions] set, as [configure] does. */
    var channel: String?
        get() = recordedChannel

        @Deprecated(CONFIGURE_DEPRECATION)
        set(value) {
            legacyWrite("HotUpdaterConfig.channel", mapOf("channel" to value)) { recordedChannel = value }
        }

    /**
     * When set, main uses this value verbatim as its storage isolation key,
     * bypassing the default `HotUpdaterPrefs_{fingerprint}_{minBundleId}_{channel}`
     * (fingerprint strategy) or `HotUpdaterPrefs_{appVersion}_{channel}`
     * (appVersion strategy) composition.
     */
    var isolationKey: String?
        get() = recordedIsolationKey

        @Deprecated(CONFIGURE_DEPRECATION)
        set(value) {
            synchronized(MainInstanceConfiguration.shared) { recordedIsolationKey = value }
        }

    /**
     * Replaces all four values; a null argument means no override. It still
     * replaces values main's [HotUpdaterOptions] set, and warns when it does.
     * Main's impl reads the values once, when it is created; a later call
     * changes only main's static entry points.
     */
    @Deprecated(CONFIGURE_DEPRECATION)
    fun configure(
        fingerprintHash: String? = null,
        publicKey: String? = null,
        channel: String? = null,
        isolationKey: String? = null,
    ) {
        // One write, so main's impl never reads half of it.
        legacyWrite(
            "HotUpdater.configure",
            mapOf("channel" to channel, "fingerprintHash" to fingerprintHash, "publicKey" to publicKey),
        ) {
            recordedFingerprintHash = fingerprintHash
            recordedPublicKey = publicKey
            recordedChannel = channel
            recordedIsolationKey = isolationKey
        }
    }

    @Deprecated(CONFIGURE_DEPRECATION)
    @Suppress("DEPRECATION")
    fun clear() {
        configure()
    }

    // A write of the deprecated API, of the [written] values by field, under
    // the lock main's impl reads its values under, warning when it replaces
    // a value main's options set.
    private fun legacyWrite(
        source: String,
        written: Map<String, String?>,
        write: () -> Unit,
    ) {
        val configuration = MainInstanceConfiguration.shared
        synchronized(configuration) {
            configuration.warnIfLegacyWriteOverrides(source, written)
            write()
        }
    }
}

/**
 * Records the channel, fingerprint hash, and public key of the `main`
 * instance's [HotUpdaterOptions] into [HotUpdaterConfig] before main's impl
 * exists, and refuses values that would contradict what main already uses.
 */
internal class MainInstanceConfiguration {
    companion object {
        private const val TAG = "HotUpdaterConfig"

        /** Main's: the one HotUpdater.init, HotUpdater.getInstance, and HotUpdaterConfig use. */
        val shared = MainInstanceConfiguration()
    }

    /** Where the warning about `HotUpdater.configure` overriding main's options goes. */
    @Volatile
    internal var logWarning: (String) -> Unit = { message -> Log.w(TAG, message) }

    // The values main's options set, by field, until HotUpdater.configure
    // replaces them.
    private var claimed = emptyMap<String, String>()

    // The values main's impl was created with, once it was: its storage key
    // and stored bundles are fixed to them, whatever HotUpdater.configure
    // sets later.
    @get:Synchronized
    var createdWith: MainImplValues? = null
        private set

    /**
     * Creates main's impl from one snapshot of its values, which it reads
     * from then on, and records the snapshot. Writes to HotUpdaterConfig wait
     * for the snapshot and never reach the impl.
     */
    fun createImpl(
        context: Context,
        create: (Context, HotUpdaterInstanceEnvironment) -> HotUpdaterImpl = { appContext, environment ->
            HotUpdaterImpl(appContext, environment)
        },
    ): HotUpdaterImpl {
        val values =
            synchronized(this) {
                MainImplValues.read(context).also { createdWith = it }
            }
        return create(context, HotUpdaterInstanceEnvironment.main(values))
    }

    /**
     * Before main's impl exists, records every value [options] set and
     * main's config doesn't hold yet. Values left null keep what main holds.
     * @throws IllegalArgumentException when [options] set a channel,
     * fingerprint hash, or public key other than the one main's config
     * already holds, from earlier options or `HotUpdater.configure`, or, once
     * main's impl exists, other than the one it uses
     */
    @Synchronized
    fun claim(options: HotUpdaterOptions) = claim(options, createdWith)

    /** [claim], with the values main's impl was created with, or null before it exists. */
    @Synchronized
    fun claim(
        options: HotUpdaterOptions,
        createdWith: MainImplValues?,
    ) {
        val implCreated = createdWith != null
        val fields =
            listOf(
                Field("channel", options.channel.nonEmpty(), HotUpdaterConfig.channel.nonEmpty(), createdWith?.channel),
                Field(
                    "fingerprintHash",
                    options.fingerprintHash.nonEmpty(),
                    HotUpdaterConfig.fingerprintHash.nonEmpty(),
                    createdWith?.fingerprintHash,
                ),
                Field("publicKey", options.publicKey.nonEmpty(), HotUpdaterConfig.publicKey.nonEmpty(), createdWith?.publicKey),
            )
        fields.forEach { field ->
            val requested = field.requested ?: return@forEach
            // Once the impl exists, a value it doesn't use, even where it uses
            // none, would be ignored.
            val conflicts = if (implCreated) field.inUse != requested else field.held != null && field.held != requested
            require(!conflicts) {
                "HotUpdater instance \"main\" was already created with another ${field.name}"
            }
        }
        claimed = claimed + fields.mapNotNull { field -> field.requested?.let { field.name to it } }
        if (implCreated) return
        options.channel.nonEmpty()?.let { HotUpdaterConfig.recordedChannel = it }
        options.fingerprintHash.nonEmpty()?.let { HotUpdaterConfig.recordedFingerprintHash = it }
        options.publicKey.nonEmpty()?.let { HotUpdaterConfig.recordedPublicKey = it }
    }

    /**
     * Warns, once for each value main's options set, when [source], the
     * deprecated `HotUpdater.configure` or a `HotUpdaterConfig` setter,
     * replaces it with another of [written], by field. The write still
     * replaces it, as it always has; the field is the legacy API's from then on.
     */
    @Synchronized
    fun warnIfLegacyWriteOverrides(
        source: String,
        written: Map<String, String?>,
    ) {
        val replaced =
            written.mapNotNull { (name, value) ->
                val set = claimed[name] ?: return@mapNotNull null
                if (set == value.nonEmpty()) return@mapNotNull null
                // A PEM key is long; its name says enough.
                if (name == "publicKey") "publicKey" else "$name \"$set\" with ${value.nonEmpty()?.let { "\"$it\"" } ?: "none"}"
            }
        claimed = claimed - written.keys
        if (replaced.isEmpty()) return
        logWarning(
            "$source replaced the ${replaced.joinToString()} that HotUpdaterOptions of instance \"main\" set. " +
                "It is deprecated: pass channel, fingerprintHash, and publicKey only through HotUpdaterOptions.",
        )
    }

    // An empty string sets nothing, as in HotUpdater.configure.
    private fun String?.nonEmpty(): String? = this?.takeIf { it.isNotEmpty() }

    private class Field(
        val name: String,
        val requested: String?,
        val held: String?,
        val inUse: String?,
    )
}

/** The channel, fingerprint hash, public key, and isolation key override main's impl reads. */
internal class MainImplValues(
    val channel: String,
    val fingerprintHash: String?,
    val publicKey: String?,
    val isolationKey: String?,
) {
    companion object {
        /** HotUpdaterConfig's values, then the manifest's, as main's static entry points read them. */
        fun read(context: Context): MainImplValues {
            val main = HotUpdaterInstanceEnvironment.main
            return MainImplValues(
                main.defaultChannel(context),
                main.fingerprintHash(context),
                main.publicKey(context),
                HotUpdaterConfig.isolationKey,
            )
        }
    }
}
