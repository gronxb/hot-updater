package com.hotupdater

/**
 * Thread-safe programmatic configuration holder for HotUpdater.
 *
 * When values are set here, they take priority over manifest metadata and
 * Android string resources. This enables brownfield/AAR setups where the RN
 * module cannot rely on the host app's manifest/strings.xml for configuration.
 */
object HotUpdaterConfig {
    @Volatile
    var fingerprintHash: String? = null

    @Volatile
    var publicKey: String? = null

    @Volatile
    var channel: String? = null

    /**
     * When set, this value is used verbatim as the storage isolation key,
     * bypassing the default `HotUpdaterPrefs_{fingerprint}_{appVersion}_{channel}`
     * composition. Use this to keep the OTA cache stable across host app version
     * bumps (e.g. key only by fingerprint + channel).
     */
    @Volatile
    var isolationKey: String? = null

    fun configure(
        fingerprintHash: String? = null,
        publicKey: String? = null,
        channel: String? = null,
        isolationKey: String? = null,
    ) {
        this.fingerprintHash = fingerprintHash
        this.publicKey = publicKey
        this.channel = channel
        this.isolationKey = isolationKey
    }

    fun clear() {
        fingerprintHash = null
        publicKey = null
        channel = null
        isolationKey = null
    }
}
