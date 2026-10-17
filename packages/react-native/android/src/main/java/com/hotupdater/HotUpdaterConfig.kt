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
    @Volatile
    var fingerprintHash: String? = null
        @Deprecated(CONFIGURE_DEPRECATION)
        set

    @Volatile
    var publicKey: String? = null
        @Deprecated(CONFIGURE_DEPRECATION)
        set

    @Volatile
    var channel: String? = null
        @Deprecated(CONFIGURE_DEPRECATION)
        set

    /**
     * When set, main uses this value verbatim as its storage isolation key,
     * bypassing the default `HotUpdaterPrefs_{fingerprint}_{minBundleId}_{channel}`
     * (fingerprint strategy) or `HotUpdaterPrefs_{appVersion}_{channel}`
     * (appVersion strategy) composition.
     */
    @Volatile
    var isolationKey: String? = null
        @Deprecated(CONFIGURE_DEPRECATION)
        set

    /**
     * Replaces all four values; a null argument means no override. It still
     * replaces values main's [HotUpdaterOptions] set, and warns when it does.
     */
    @Deprecated(CONFIGURE_DEPRECATION)
    @Suppress("DEPRECATION")
    fun configure(
        fingerprintHash: String? = null,
        publicKey: String? = null,
        channel: String? = null,
        isolationKey: String? = null,
    ) {
        // Under the lock main's impl is created with, so the impl reads the
        // values it records.
        synchronized(MainInstanceConfiguration) {
            MainInstanceConfiguration.warnIfConfigureOverrides(fingerprintHash = fingerprintHash, publicKey = publicKey, channel = channel)
            this.fingerprintHash = fingerprintHash
            this.publicKey = publicKey
            this.channel = channel
            this.isolationKey = isolationKey
        }
    }

    @Deprecated(CONFIGURE_DEPRECATION)
    @Suppress("DEPRECATION")
    fun clear() {
        configure()
    }
}

/**
 * Records the channel, fingerprint hash, and public key of the `main`
 * instance's [HotUpdaterOptions] into [HotUpdaterConfig] before main's impl
 * exists, and refuses values that would contradict what main already uses.
 */
internal object MainInstanceConfiguration {
    private const val TAG = "HotUpdaterConfig"

    /** Where the warning about `HotUpdater.configure` overriding main's options goes. */
    @Volatile
    internal var logWarning: (String) -> Unit = { message -> Log.w(TAG, message) }

    // The values main's options set, by field, until HotUpdater.configure
    // replaces them.
    private var claimed = emptyMap<String, String>()

    // The values main's impl was created with, once it was: its storage key
    // and stored bundles are fixed to them, whatever HotUpdater.configure
    // sets later.
    private var createdWith: MainImplValues? = null

    /**
     * Creates main's impl with [create], recording the values it is created
     * with. Options and `HotUpdater.configure` wait for it.
     */
    @Synchronized
    fun createImpl(
        context: Context,
        create: () -> HotUpdaterImpl,
    ): HotUpdaterImpl {
        createdWith = MainImplValues.read(context)
        return create()
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
    fun claim(
        context: Context,
        options: HotUpdaterOptions,
    ) = claim(options, createdWith)

    /** [claim], with the values main's impl was created with, or null before it exists. */
    @Synchronized
    @Suppress("DEPRECATION")
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
        options.channel.nonEmpty()?.let { HotUpdaterConfig.channel = it }
        options.fingerprintHash.nonEmpty()?.let { HotUpdaterConfig.fingerprintHash = it }
        options.publicKey.nonEmpty()?.let { HotUpdaterConfig.publicKey = it }
    }

    /**
     * Warns, once for the values main's options set, when the deprecated
     * `HotUpdater.configure` replaces one of them. The call still replaces
     * them, as it always has; the values it sets are its own from then on.
     */
    @Synchronized
    fun warnIfConfigureOverrides(
        fingerprintHash: String?,
        publicKey: String?,
        channel: String?,
    ) {
        val replaced =
            listOf("channel" to channel, "fingerprintHash" to fingerprintHash, "publicKey" to publicKey)
                .mapNotNull { (name, value) ->
                    val set = claimed[name] ?: return@mapNotNull null
                    if (set == value.nonEmpty()) return@mapNotNull null
                    // A PEM key is long; its name says enough.
                    if (name == "publicKey") "publicKey" else "$name \"$set\" with ${value.nonEmpty()?.let { "\"$it\"" } ?: "none"}"
                }
        claimed = emptyMap()
        if (replaced.isEmpty()) return
        logWarning(
            "HotUpdater.configure replaced the ${replaced.joinToString()} that HotUpdaterOptions of instance \"main\" set. " +
                "configure is deprecated: pass channel, fingerprintHash, and publicKey only through HotUpdaterOptions.",
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

/** The channel, fingerprint hash, and public key main's impl reads. */
internal class MainImplValues(
    val channel: String,
    val fingerprintHash: String?,
    val publicKey: String?,
) {
    companion object {
        fun read(context: Context): MainImplValues {
            val main = HotUpdaterInstanceEnvironment.main
            return MainImplValues(main.defaultChannel(context), main.fingerprintHash(context), main.publicKey(context))
        }
    }
}
