package com.hotupdater

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * The coordinator's view of the SDK: main's native state, and its server as the
 * app's JavaScript left it after an answered check. No new native API: the check
 * and the update are `HotUpdaterInstance`'s, and the preflight reads through the
 * same catalog client, so the check that follows it costs a 304.
 */
internal class HotUpdaterSandboxLiveHost(
    context: Context,
) : HotUpdaterSandboxHost {
    private val context = context.applicationContext
    private val impl get() = HotUpdater.getInstance(context)

    private fun config() = RecoveryCheckConfig.parse(impl.getStorageItem(RecoveryCheckConfig.KEY))

    private fun requireConfig() = config() ?: throw IllegalStateException("No update server is known yet")

    private fun instance(config: RecoveryCheckConfig) =
        HotUpdater.init(
            context,
            HotUpdaterOptions(
                baseURL = config.baseURL,
                requestHeaders = config.requestHeaders,
                requestTimeoutMillis = config.requestTimeoutMillis,
            ),
        )

    override fun fingerprintHash(): String? = impl.getFingerprintHash()

    override fun hasServerConfig(): Boolean = config() != null

    override suspend fun selection(): HotUpdaterSandboxSelection =
        withContext(Dispatchers.IO) {
            val builtIn = HotUpdaterImpl.getMinBundleId()
            val bundleId = impl.getBundleIdForUpdateCheck() ?: builtIn
            HotUpdaterSandboxSelection(
                channel = impl.getChannel(),
                defaultChannel = impl.getDefaultChannel(),
                bundleId = bundleId,
                isBuiltIn = bundleId == builtIn,
            )
        }

    override suspend fun preflight(channel: String): Boolean =
        withContext(Dispatchers.IO) {
            val config = requireConfig()
            val state = HotUpdaterImplUpdateCheckState(context, impl)
            val channelKey = ReleaseCatalogs.encodeChannelKey(channel)
            val strategy = config.updateStrategy.releaseStrategy
            val baseURL = config.baseURL.trimEnd('/')
            val (scope, url) =
                if (strategy == ReleaseStrategy.APP_VERSION) {
                    val appVersion =
                        state.getAppVersion()?.let(ReleaseCatalogs::canonicalizeAppVersion)
                            ?: throw IllegalStateException("Failed to canonicalize app version")
                    ReleaseCatalogScope.AppVersion(platform = PLATFORM, channelKey = channelKey) to
                        "$baseURL/release-catalogs/app-version/$PLATFORM/$channelKey/${encodeURIComponent(appVersion)}"
                } else {
                    val fingerprintHash =
                        state.getFingerprintHash()?.takeIf { it.isNotEmpty() }
                            ?: throw IllegalStateException("Fingerprint hash is required")
                    ReleaseCatalogScope.Fingerprint(
                        platform = PLATFORM,
                        channelKey = channelKey,
                        fingerprintHash = fingerprintHash,
                    ) to "$baseURL/release-catalogs/fingerprint/$PLATFORM/$channelKey/${encodeURIComponent(fingerprintHash)}"
                }
            val catalog =
                ReleaseCatalogClient(state, OkHttpUpdateCheckTransport()).fetchReleaseCatalog(
                    baseURL = baseURL,
                    url = url,
                    expectedScope = scope,
                    requestHeaders = config.requestHeaders,
                    requestTimeoutMillis = config.requestTimeoutMillis,
                ) ?: return@withContext false
            val builtIn = state.getMinBundleId()
            // What this device would select once it left its bundles behind.
            val desired =
                ReleaseSelector.selectDesiredRelease(
                    catalog,
                    ReleaseSelectionInput(
                        builtInBundleId = builtIn,
                        currentBundleId = builtIn,
                        activeReleaseId = null,
                        runningReleaseId = RunningReleaseId.Explicit(null),
                        minimumReleaseId = builtIn,
                        cohort = ReleaseSelector.normalizeCohortValue(state.getCohort()),
                        crashedBundleIds = state.getCrashHistory(),
                    ),
                )
            desired != null && desired.kind != SelectionKind.BUILTIN
        }

    override suspend fun reset(): Boolean = withContext(Dispatchers.IO) { instance(requireConfig()).resetChannel() }

    override suspend fun checkAndStage(
        channel: String,
        onProgress: (Double) -> Unit,
    ): HotUpdaterSandboxStaged =
        withContext(Dispatchers.IO) {
            val config = requireConfig()
            val update =
                instance(config).checkForUpdate(
                    HotUpdaterCheckOptions(updateStrategy = config.updateStrategy, channel = channel),
                ) ?: return@withContext HotUpdaterSandboxStaged.NoUpdate
            if (!update.updateBundle(onProgress)) return@withContext HotUpdaterSandboxStaged.Superseded
            val active = impl.getActiveUpdateState()["activeSelection"] as? Map<*, *>
            HotUpdaterSandboxStaged.Update(active?.get("bundleId") as? String ?: HotUpdaterImpl.getMinBundleId())
        }

    private companion object {
        const val PLATFORM = "android"
    }
}

/**
 * The sandbox's own file: an app's data and the SDK's stores stay as they are.
 * Every write reaches the disk before it returns, since a switch ends by killing
 * this process, and a link that's gone from memory but not from disk asks again.
 */
internal class HotUpdaterSandboxPreferences(
    context: Context,
) : HotUpdaterSandboxStore {
    private val preferences: SharedPreferences =
        context.applicationContext.getSharedPreferences("hot_updater_sandbox", Context.MODE_PRIVATE)

    override var pendingLinks: List<String>
        get() {
            val value = preferences.getString(PENDING_LINKS, null) ?: return emptyList()
            return runCatching {
                val links = JSONArray(value)
                (0 until links.length()).map(links::getString)
            }.getOrDefault(emptyList())
        }
        set(value) {
            preferences.edit().putString(PENDING_LINKS, JSONArray(value).toString()).commit()
        }

    override fun recordSelected(selection: HotUpdaterSandboxSelection) = record(SELECTED, selection)

    override fun recordOpened(selection: HotUpdaterSandboxSelection) = record(OPENED, selection)

    private fun record(
        key: String,
        selection: HotUpdaterSandboxSelection,
    ) {
        preferences
            .edit()
            .putString(
                key,
                JSONObject()
                    .put("channel", selection.channel)
                    .put("bundleId", selection.bundleId)
                    .toString(),
            ).commit()
    }

    private companion object {
        const val PENDING_LINKS = "pendingLinks"
        const val SELECTED = "selected"
        const val OPENED = "opened"
    }
}
