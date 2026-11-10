package com.hotupdater

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.view.View
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import androidx.core.view.WindowCompat
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TAG = "HotUpdaterSandbox"
private const val HELP_URL = "https://hot-updater.dev/docs/native-builds/sandbox"
private const val GEIST_LICENSE = "Geist, SIL Open Font License 1.1"
private const val CONFIRM_CLEAR = "clear"
private const val CONFIRM_RESET = "reset"
private const val SAVED_TAB = "hotUpdaterSandboxTab"
private const val SAVED_EXPANDED = "hotUpdaterSandboxExpanded"
private const val SAVED_TYPED = "hotUpdaterSandboxTyped"
private val CODE_ROWS = setOf("Fingerprint", "Built-in bundle", "Default channel", "Channel", "Current", "Pending")

/** What a phase asks, in the same words on every screen that asks it. */
internal data class HotUpdaterSandboxQuestion(
    val kind: Kind,
    val title: String,
    val message: String,
    val accept: String,
    val decline: String?,
) {
    enum class Kind { CONFIRM, REFUSED, FAILED }

    companion object {
        /** [isOverApp]: whether a bundle runs behind the screen for a link to replace. */
        fun of(
            phase: HotUpdaterSandboxPhase,
            isOverApp: Boolean,
        ): HotUpdaterSandboxQuestion? =
            when (phase) {
                is HotUpdaterSandboxPhase.Confirming ->
                    HotUpdaterSandboxQuestion(
                        Kind.CONFIRM,
                        "Open latest on ${phase.link.channel}?",
                        if (isOverApp) {
                            "This replaces the running bundle. Downloaded bundles stay listed."
                        } else {
                            HotUpdaterSandboxHomeModel.SWITCH_NOTE
                        },
                        "Open latest",
                        "Cancel",
                    )
                is HotUpdaterSandboxPhase.Refused ->
                    when (val refusal = phase.refusal) {
                        is HotUpdaterSandboxRefusal.Unreadable ->
                            HotUpdaterSandboxQuestion(
                                Kind.REFUSED,
                                "This link can't be read",
                                "It isn't a link for this app.",
                                "OK",
                                null,
                            )
                        is HotUpdaterSandboxRefusal.InvalidChannel ->
                            HotUpdaterSandboxQuestion(
                                Kind.REFUSED,
                                "That isn't a channel name",
                                "Check \"${refusal.channel}\" and try again.",
                                "OK",
                                null,
                            )
                        is HotUpdaterSandboxRefusal.OtherFingerprint ->
                            HotUpdaterSandboxQuestion(
                                Kind.REFUSED,
                                "${refusal.link.channel} needs another build",
                                "Its native code differs from this build. Install the sandbox build for that fingerprint.",
                                "OK",
                                null,
                            )
                        is HotUpdaterSandboxRefusal.OtherPlatform ->
                            HotUpdaterSandboxQuestion(
                                Kind.REFUSED,
                                "This QR is for iOS",
                                "Scan the Android QR code for ${refusal.link.channel}.",
                                "OK",
                                null,
                            )
                    }
                is HotUpdaterSandboxPhase.Failed -> {
                    val reason =
                        when (val failure = phase.failure) {
                            HotUpdaterSandboxFailure.NoBundle -> "${phase.target} has no bundle for this build."
                            HotUpdaterSandboxFailure.ResetFailed -> "Downloaded bundles couldn't be removed."
                            HotUpdaterSandboxFailure.Superseded -> "Another update check changed the selection first."
                            HotUpdaterSandboxFailure.InStoredSession ->
                                "A stored bundle is running. Go back to the current bundle, then try again."
                            is HotUpdaterSandboxFailure.Error -> failure.message
                        }
                    val bundle = if (phase.selection.isBuiltIn) "built-in bundle" else "bundle ${phase.selection.bundleId}"
                    HotUpdaterSandboxQuestion(
                        Kind.FAILED,
                        "Couldn't open ${phase.target}",
                        "$reason\n\nSelected now: ${phase.selection.channel}, $bundle.",
                        if (phase.failure == HotUpdaterSandboxFailure.InStoredSession) "Back" else "Retry",
                        "Close",
                    )
                }
                else -> null
            }
    }
}

/**
 * The first screen, and the same screen over a running app. It renders
 * [HotUpdaterSandboxState] and calls the coordinator's actions. Reads only:
 * opening it sends the update server nothing.
 */
internal class HotUpdaterSandboxScreen(
    private val activity: HotUpdaterSandboxActivity,
    private val coordinator: HotUpdaterSandboxCoordinator,
    private val devServer: HotUpdaterSandboxDevServer,
    saved: Bundle?,
) {
    private var state by mutableStateOf(coordinator.state)
    private var devServerRevision by mutableIntStateOf(0)

    /**
     * What a person is in the middle of: the tab, the open form and what's typed in
     * each. They live here, not in a pane, so a fold or a rotation that lays the
     * panes out again keeps them.
     */
    private var tab by mutableIntStateOf(saved?.getInt(SAVED_TAB) ?: 0)
    private var expanded by mutableStateOf(saved?.getString(SAVED_EXPANDED))
    private val typed =
        mutableStateMapOf<String, String>().apply {
            saved?.getBundle(SAVED_TYPED)?.let { bundle -> bundle.keySet().forEach { put(it, bundle.getString(it).orEmpty()) } }
        }

    /** The question a person asked for, Clear or Reset, and the license, open across a new layout. */
    private var confirming by mutableStateOf<String?>(null)

    /** The Downloaded row a person pressed and held. */
    private var menuFor by mutableStateOf<HotUpdaterSandboxHomeModel.Downloaded?>(null)
    private var showsLicense by mutableStateOf(false)
    private val homeScroll = ScrollState(0)
    private val infoScroll = ScrollState(0)

    /** A dev server that didn't answer, or a phone with no camera app: a title and what to do. */
    private var notice by mutableStateOf<Pair<String, String>?>(null)

    private val appName = activity.applicationInfo.loadLabel(activity.packageManager).toString()
    private val appIcon: Drawable? = runCatching { activity.applicationInfo.loadIcon(activity.packageManager) }.getOrNull()
    private val version =
        activity.packageManager.getPackageInfo(activity.packageName, 0).let {
            @Suppress("DEPRECATION")
            "${it.versionName} (${it.versionCode})"
        }
    private val configuration =
        if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) "Debug" else "Release"

    val view: View =
        ComposeView(activity).apply {
            setContent { SandboxTheme { Root() } }
        }

    init {
        devServer.onDevServerChange = { devServerRevision++ }
    }

    /** What a recreated activity, such as after a font size change, gets back. */
    fun save(out: Bundle) {
        out.putInt(SAVED_TAB, tab)
        out.putString(SAVED_EXPANDED, expanded)
        out.putBundle(SAVED_TYPED, Bundle().apply { typed.forEach { (id, text) -> putString(id, text) } })
    }

    fun render(next: HotUpdaterSandboxState) {
        state = next
    }

    private fun home(state: HotUpdaterSandboxState) =
        HotUpdaterSandboxHomeModel.of(state, activity.isOverApp, devServer.runningDevServerHost, System.currentTimeMillis())

    private fun close() {
        coordinator.acknowledgeLastLaunch()
        activity.finish()
    }

    private fun connect(host: String) {
        devServer.connect(host) { problem ->
            if (problem != null) notice = "Couldn't connect to $host" to problem
        }
    }

    // MARK: layout

    @Composable
    private fun Root() {
        val colors = LocalSandboxColors.current
        val dark = colors == SandboxColors.dark
        val view = LocalView.current
        SideEffect {
            // The status and navigation bar icons follow a dark mode switched while this is up.
            WindowCompat.getInsetsController(activity.window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
        val layout by remember { WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity) }
            .collectAsState<WindowLayoutInfo, WindowLayoutInfo?>(null)
        val fold = layout?.displayFeatures?.filterIsInstance<FoldingFeature>()?.firstOrNull { it.isSeparating }
        Box(Modifier.fillMaxSize().background(colors.background)) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val density = LocalDensity.current
                when {
                    fold != null && fold.orientation == FoldingFeature.Orientation.VERTICAL -> {
                        // One pane on each side of the hinge, none on it.
                        val first = with(density) { fold.bounds.left.toDp() }
                        val hinge = with(density) { fold.bounds.width().toDp() }
                        Row(Modifier.fillMaxSize()) {
                            Box(Modifier.width(first).fillMaxHeight()) { HomePane(showsClose = true) }
                            Spacer(Modifier.width(hinge))
                            Box(Modifier.weight(1f).fillMaxHeight()) { InfoPane(showsClose = false) }
                        }
                    }
                    fold != null -> {
                        // Tabletop: the screen above the hinge, its details below.
                        val first = with(density) { fold.bounds.top.toDp() }
                        val hinge = with(density) { fold.bounds.height().toDp() }
                        Column(Modifier.fillMaxSize()) {
                            Box(Modifier.height(first).fillMaxWidth()) { HomePane(showsClose = true) }
                            Spacer(Modifier.height(hinge))
                            Box(Modifier.weight(1f).fillMaxWidth()) { InfoPane(showsClose = false) }
                        }
                    }
                    maxWidth >= 600.dp ->
                        Row(Modifier.fillMaxSize()) {
                            Box(Modifier.weight(1f).fillMaxHeight()) { HomePane(showsClose = true) }
                            Box(Modifier.width(0.5.dp).fillMaxHeight().background(colors.separator))
                            Box(Modifier.weight(1f).fillMaxHeight()) { InfoPane(showsClose = false) }
                        }
                    else -> Tabs()
                }
            }
        }
        Questions()
    }

    @Composable
    private fun Tabs() {
        val colors = LocalSandboxColors.current
        var barHeight by remember { mutableIntStateOf(0) }
        Column(Modifier.fillMaxSize()) {
            // The tab bar below takes the navigation bar's inset, and the keyboard
            // covers the whole bar: the pane avoids only what reaches above it.
            val bar = with(LocalDensity.current) { barHeight.toDp() }
            Box(Modifier.weight(1f).consumeWindowInsets(PaddingValues(bottom = bar))) {
                if (tab == 0) HomePane(showsClose = true) else InfoPane(showsClose = true)
            }
            Column(Modifier.onSizeChanged { barHeight = it.height }) {
                Box(Modifier.fillMaxWidth().height(0.5.dp).background(colors.separator))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(colors.surface)
                        .windowInsetsPadding(WindowInsets.navigationBars),
                ) {
                    TabItem("Home", R.drawable.hot_updater_sandbox_home, tab == 0) { tab = 0 }
                    TabItem("Info", R.drawable.hot_updater_sandbox_info, tab == 1) { tab = 1 }
                }
            }
        }
    }

    @Composable
    private fun androidx.compose.foundation.layout.RowScope.TabItem(
        title: String,
        icon: Int,
        selected: Boolean,
        onClick: () -> Unit,
    ) {
        val colors = LocalSandboxColors.current
        val color = if (selected) colors.accent else colors.muted
        Column(
            Modifier
                .weight(1f)
                .heightIn(min = 56.dp)
                .sandboxPressable(role = Role.Tab, pressedColor = colors.fill, onClick = onClick)
                .semantics { this.selected = selected }
                .padding(vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            SandboxIcon(icon, color, 24.dp)
            SandboxText(title, SandboxType.badge, color)
        }
    }

    /** A pane's scrolling page: off the status bar, the cutout and the keyboard, and no wider than reads well. */
    @Composable
    private fun Page(
        scroll: ScrollState,
        content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                Modifier
                    .widthIn(max = 640.dp)
                    .fillMaxWidth()
                    .verticalScroll(scroll)
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(28.dp),
                content = content,
            )
        }
    }

    // MARK: Home

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun HomePane(showsClose: Boolean) {
        val colors = LocalSandboxColors.current
        val haptics = LocalView.current
        val focus = LocalFocusManager.current
        // Reading the revision redraws this pane when the dev server changes.
        val home = remember(state, devServerRevision) { home(state) }
        // Back closes an open form first.
        BackHandler(enabled = expanded != null) {
            focus.clearFocus()
            expanded = null
        }
        Page(homeScroll) {
            Header(showsClose)
            home.status?.let { StatusCard(it) }
            home.banner?.let { banner ->
                SandboxCard {
                    Row(Modifier.padding(16.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
                        SandboxIcon(R.drawable.hot_updater_sandbox_warning, colors.danger, 20.dp)
                        Spacer(Modifier.width(12.dp))
                        SandboxText(banner.text, SandboxType.body)
                    }
                    if (banner.offersReset) {
                        SandboxDivider(leading = false)
                        SandboxDestructiveRow("Reset to built-in bundle", enabled = !home.isBusy) { confirming = CONFIRM_RESET }
                    }
                }
            }
            SandboxSection(home.bigRow.caption) {
                SandboxCard {
                    SandboxRow(
                        lead =
                            SandboxLead.Primary(
                                if (home.bigRow.action.opens) {
                                    R.drawable.hot_updater_sandbox_play
                                } else {
                                    R.drawable.hot_updater_sandbox_reload
                                },
                            ),
                        title = home.bigRow.title,
                        titleStyle = SandboxType.headline,
                        subtitle = home.bigRow.subtitle,
                        detail = home.bigRow.detail,
                        // A deploy message leads with what identifies it, such as a commit: one line keeps it in view.
                        detailMaxLines = 1,
                        enabled = !home.isBusy,
                    ) {
                        SandboxHaptic.tap(haptics)
                        focus.clearFocus()
                        coordinator.tap(home.bigRow.action, devServer)
                    }
                    if (home.bigRow.showsBack) {
                        SandboxDivider()
                        SandboxRow(SandboxLead.Icon(R.drawable.hot_updater_sandbox_back), "Back to current bundle", showsChevron = false) {
                            SandboxHaptic.tap(haptics)
                            coordinator.leaveStoredSession()
                        }
                    }
                }
            }
            SandboxSection(
                "Dev server",
                "Help" to {
                    runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(HELP_URL))) }
                    Unit
                },
            ) {
                SandboxCard {
                    val running = devServer.runningDevServerHost
                    if (running != null) {
                        SandboxRow(
                            SandboxLead.Dot(true),
                            running,
                            SandboxType.codeHeadline,
                            devServer.lastDevServerError ?: "Dev server running",
                        ) { devServer.reloadDevServer() }
                        SandboxDivider()
                        SandboxRow(SandboxLead.Icon(R.drawable.hot_updater_sandbox_exit), "Exit dev server", showsChevron = false) {
                            devServer.exitDevServer()
                        }
                    } else {
                        devServer.devServerHosts.forEach { host ->
                            key(host.address) {
                                SandboxRow(
                                    SandboxLead.Dot(host.isRunning == true),
                                    host.address,
                                    SandboxType.codeHeadline,
                                    when (host.isRunning) {
                                        true -> "Dev server running"
                                        false -> "Not running. Start your dev server, then tap to retry."
                                        null -> "Tap to connect"
                                    },
                                    enabled = !home.isBusy,
                                ) { connect(host.address) }
                                SandboxDivider()
                            }
                        }
                        Entry(
                            id = "url",
                            expanded = expanded,
                            onExpand = { expanded = it },
                            icon = R.drawable.hot_updater_sandbox_link,
                            title = "Enter URL manually",
                            placeholder = "192.168.0.10:8081",
                            fieldLabel = "Dev server address",
                            action = "Connect",
                            keyboardType = KeyboardType.Uri,
                            enabled = !home.isBusy,
                            submit = ::connect,
                        )
                    }
                }
            }
            SandboxSection(
                "Channels",
                footer = listOfNotNull(home.previewHint, HotUpdaterSandboxHomeModel.SWITCH_NOTE).joinToString(" "),
            ) {
                SandboxCard {
                    SandboxRow(SandboxLead.Icon(R.drawable.hot_updater_sandbox_qr), "Scan QR code", enabled = !home.isBusy) {
                        SandboxHaptic.tap(haptics)
                        openCamera()
                    }
                    SandboxDivider()
                    Entry(
                        id = "channel",
                        expanded = expanded,
                        onExpand = { expanded = it },
                        icon = R.drawable.hot_updater_sandbox_keyboard,
                        title = "Enter a channel",
                        placeholder = "Channel",
                        fieldLabel = "Channel or link",
                        action = "Open latest",
                        keyboardType = KeyboardType.Ascii,
                        enabled = !home.isBusy,
                    ) { coordinator.switchTo(it) }
                }
            }
            SandboxSection(
                "Downloaded",
                ("Clear" to { confirming = CONFIRM_CLEAR }).takeIf { home.downloaded.any { !it.isRunning } },
                footer = home.downloadedFooter,
            ) {
                if (home.downloaded.isNotEmpty()) {
                    SandboxCard {
                        home.downloaded.forEachIndexed { index, row ->
                            key(row.bundleId) {
                                if (index > 0) SandboxDivider()
                                SandboxRow(
                                    SandboxLead.Icon(R.drawable.hot_updater_sandbox_box),
                                    row.channel,
                                    SandboxType.codeHeadline,
                                    row.message,
                                    row.detail,
                                    enabled = !home.isBusy,
                                    badge = "Running".takeIf { row.isRunning },
                                    onLongClick = {
                                        SandboxHaptic.toggle(haptics)
                                        menuFor = row
                                    },
                                ) {
                                    SandboxHaptic.tap(haptics)
                                    focus.clearFocus()
                                    coordinator.openDownloaded(row.bundleId)
                                }
                            }
                        }
                    }
                }
            }
            SandboxText(
                HotUpdaterSandboxHomeModel.HINT,
                SandboxType.footnote,
                colors.textSecondary,
                Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
            )
        }
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun Entry(
        id: String,
        expanded: String?,
        onExpand: (String?) -> Unit,
        icon: Int,
        title: String,
        placeholder: String,
        fieldLabel: String,
        action: String,
        keyboardType: KeyboardType,
        enabled: Boolean,
        submit: (String) -> Unit,
    ) {
        val haptics = LocalView.current
        val focus = LocalFocusManager.current
        val isOpen = expanded == id
        val text = typed[id].orEmpty()
        val field = remember { FocusRequester() }
        val reveal = remember { BringIntoViewRequester() }
        val button = remember { BringIntoViewRequester() }

        // The whole form when it fits, and its button always: a form taller than
        // what the keyboard leaves, such as on a phone on its side, doesn't scroll
        // as a whole, since it already spans the page's edges.
        suspend fun showForm() {
            reveal.bringIntoView()
            button.bringIntoView()
        }

        LaunchedEffect(isOpen) {
            if (!isOpen) return@LaunchedEffect
            // The field takes focus once the card has opened, then the form comes
            // into view above the keyboard.
            delay(250)
            runCatching { field.requestFocus() }
            delay(400)
            showForm()
        }
        // The keyboard's own motion restarts this at each step, so the form comes
        // into view once the keyboard rests and the page has its final height.
        val keyboard = WindowInsets.ime.getBottom(LocalDensity.current)
        LaunchedEffect(isOpen, keyboard) {
            if (!isOpen || keyboard == 0) return@LaunchedEffect
            delay(100)
            showForm()
        }
        val send = {
            val value = text.trim()
            if (value.isNotEmpty()) {
                SandboxHaptic.tap(haptics)
                typed[id] = ""
                focus.clearFocus()
                onExpand(null)
                submit(value)
            }
        }
        Box(Modifier.bringIntoViewRequester(reveal)) {
            SandboxAccordion(
                lead = SandboxLead.Icon(icon),
                title = title,
                expanded = isOpen,
                enabled = enabled,
                onToggle = {
                    SandboxHaptic.toggle(haptics)
                    if (isOpen) focus.clearFocus()
                    onExpand(if (isOpen) null else id)
                },
            ) {
                SandboxField(text, { typed[id] = it }, placeholder, fieldLabel, keyboardType, field, send)
                Box(Modifier.bringIntoViewRequester(button)) {
                    SandboxPrimaryButton(action, enabled = text.isNotBlank(), onClick = send)
                }
            }
        }
    }

    @Composable
    private fun Header(showsClose: Boolean) {
        val colors = LocalSandboxColors.current
        val large = isLargeText()
        val iconSize = (56.dp * LocalDensity.current.fontScale).coerceAtMost(80.dp)
        val shape = RoundedCornerShape(iconSize * 0.23f)
        val icon = remember { appIcon?.toBitmap(192, 192)?.asImageBitmap() }
        val iconView: @Composable () -> Unit = {
            if (icon != null) {
                Image(
                    icon,
                    contentDescription = null,
                    modifier = Modifier.size(iconSize).clip(shape).border(0.5.dp, colors.separator, shape),
                )
            }
        }
        val names: @Composable () -> Unit = {
            Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SandboxText(appName, SandboxType.title, modifier = Modifier.semantics { heading() })
                if (large) {
                    SandboxText(version, SandboxType.subhead, colors.textSecondary)
                    SandboxBadge("Sandbox")
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SandboxText(version, SandboxType.subhead, colors.textSecondary)
                        Spacer(Modifier.width(8.dp))
                        SandboxBadge("Sandbox")
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.Top) {
            // At the largest text the name goes under the icon, with the whole width.
            if (large) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    iconView()
                    names()
                }
            } else {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    iconView()
                    Spacer(Modifier.width(16.dp))
                    names()
                }
            }
            if (showsClose && activity.isOverApp) CloseButton()
        }
    }

    @Composable
    private fun CloseButton() {
        val colors = LocalSandboxColors.current
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .sandboxPressable(pressedColor = colors.fill, onClick = ::close)
                .semantics { contentDescription = "Back to the app" },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(30.dp).clip(CircleShape).background(colors.fill), contentAlignment = Alignment.Center) {
                SandboxIcon(R.drawable.hot_updater_sandbox_close, colors.textSecondary, 16.dp)
            }
        }
    }

    @Composable
    private fun StatusCard(status: HotUpdaterSandboxHomeModel.Status) {
        val colors = LocalSandboxColors.current
        SandboxCard {
            Column(Modifier.padding(16.dp).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SandboxText(status.text, SandboxType.body)
                status.progress?.let { progress ->
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(colors.fill),
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth(progress.toFloat().coerceIn(0f, 1f))
                                .fillMaxHeight()
                                .background(colors.accent),
                        )
                    }
                }
            }
        }
    }

    // MARK: Info

    @Composable
    private fun InfoPane(showsClose: Boolean) {
        val info =
            remember(state, devServerRevision) {
                HotUpdaterSandboxInfoModel.of(state, version, configuration, activity.isOverApp, devServer.runningDevServerHost)
            }
        val canReset = state.hasServerConfig && state.phase !is HotUpdaterSandboxPhase.Working
        Page(infoScroll) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                SandboxText("Info", SandboxType.title, modifier = Modifier.weight(1f).semantics { heading() })
                if (showsClose && activity.isOverApp) CloseButton()
            }
            InfoGroup("Build", info.build)
            InfoGroup("Bundle", info.bundle)
            SandboxSection(null, footer = HotUpdaterSandboxHomeModel.RESET_NOTE) {
                SandboxCard {
                    SandboxDestructiveRow("Reset to built-in bundle", enabled = canReset) { confirming = CONFIRM_RESET }
                }
            }
            SandboxSection("Licenses") {
                SandboxCard {
                    SandboxRow(null, GEIST_LICENSE) { showsLicense = true }
                }
            }
        }
    }

    @Composable
    private fun InfoGroup(
        title: String,
        rows: List<HotUpdaterSandboxInfoModel.Row>,
    ) {
        val colors = LocalSandboxColors.current
        val stacks = isLargeText()
        SandboxSection(title) {
            SandboxCard {
                rows.forEachIndexed { index, row ->
                    if (index > 0) SandboxDivider(leading = false)
                    val style = if (row.name in CODE_ROWS) SandboxType.code else SandboxType.body
                    val value = row.value.ifEmpty { "—" }
                    val modifier =
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 52.dp)
                            .padding(horizontal = 16.dp, vertical = 12.dp)
                            .semantics(mergeDescendants = true) {}
                    if (stacks) {
                        Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            SandboxText(row.name, SandboxType.body)
                            SandboxText(value, style, colors.textSecondary)
                        }
                    } else {
                        Row(modifier, verticalAlignment = Alignment.CenterVertically) {
                            SandboxText(row.name, SandboxType.body, modifier = Modifier.weight(1f))
                            Spacer(Modifier.width(12.dp))
                            SandboxText(value, style, colors.textSecondary, maxLines = 1)
                        }
                    }
                }
            }
        }
    }

    // MARK: questions

    @Composable
    private fun ResetDialog(
        scope: CoroutineScope,
        onDone: () -> Unit,
    ) {
        val haptics = LocalView.current
        SandboxDialog(
            title = "Reset to built-in bundle?",
            dismissible = true,
            message = HotUpdaterSandboxHomeModel.RESET_NOTE,
            confirm = "Reset",
            destructive = true,
            dismiss = "Cancel",
            onConfirm = {
                onDone()
                SandboxHaptic.tap(haptics)
                // A reset opens nothing: Home comes into view, its top first, where the row opens the built-in bundle.
                if (coordinator.resetToBuiltIn()) {
                    tab = 0
                    scope.launch { homeScroll.scrollTo(0) }
                }
            },
            onDismiss = onDone,
        )
    }

    @Composable
    private fun Questions() {
        val haptics = LocalView.current
        // Outlives a dialog, whose own scope ends as it closes.
        val scope = rememberCoroutineScope()
        when (confirming) {
            CONFIRM_CLEAR ->
                SandboxDialog(
                    title = "Clear downloaded bundles?",
                    message = "They're only on this device. The running one stays.",
                    confirm = "Clear",
                    destructive = true,
                    dismiss = "Cancel",
                    dismissible = true,
                    onConfirm = {
                        confirming = null
                        coordinator.clearDownloaded()
                    },
                    onDismiss = { confirming = null },
                )
            CONFIRM_RESET -> ResetDialog(scope) { confirming = null }
        }
        menuFor?.let { row ->
            SandboxActionsDialog(
                title = row.channel,
                actions =
                    listOfNotNull(
                        Triple("Open latest", false) { coordinator.switchTo(row.channel) },
                        Triple("Delete", true) { coordinator.deleteDownloaded(row.bundleId) }.takeIf { !row.isRunning },
                    ),
                onDismiss = { menuFor = null },
            )
        }
        if (showsLicense) {
            val text =
                remember {
                    activity.resources
                        .openRawResource(R.raw.hot_updater_sandbox_geist_ofl)
                        .bufferedReader()
                        .use { HotUpdaterSandboxInfoModel.reflow(it.readText()) }
                }
            SandboxTextDialog(GEIST_LICENSE, text) { showsLicense = false }
        }
        val question = HotUpdaterSandboxQuestion.of(state.phase, activity.isOverApp)
        LaunchedEffect(question) {
            if (question != null && question.kind != HotUpdaterSandboxQuestion.Kind.CONFIRM) SandboxHaptic.error(haptics)
        }
        if (question != null) {
            SandboxDialog(
                title = question.title,
                message = question.message,
                confirm = question.accept,
                dismiss = question.decline,
                onConfirm = {
                    when (question.kind) {
                        HotUpdaterSandboxQuestion.Kind.CONFIRM -> coordinator.confirmLink()
                        HotUpdaterSandboxQuestion.Kind.REFUSED -> coordinator.dismiss(activity::closeOverApp)
                        HotUpdaterSandboxQuestion.Kind.FAILED -> coordinator.retry()
                    }
                },
                onDismiss = {
                    when (question.kind) {
                        HotUpdaterSandboxQuestion.Kind.FAILED -> coordinator.dismiss()
                        else -> coordinator.dismiss(activity::closeOverApp)
                    }
                },
            )
            return
        }
        notice?.let { (title, message) ->
            LaunchedEffect(title, message) { SandboxHaptic.error(haptics) }
            SandboxDialog(
                title = title,
                message = message,
                confirm = "OK",
                dismissible = true,
                onConfirm = { notice = null },
                onDismiss = { notice = null },
            )
        }
    }

    /**
     * The system camera reads the QR, and the link comes back to the activity
     * through its intent filter. Whether a phone's camera does that needs a real
     * phone; pasting the link into "Enter a channel" works everywhere.
     */
    private fun openCamera() {
        try {
            activity.startActivity(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA))
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "no camera app", error)
            notice = "No camera app" to "Paste the link into \"Enter a channel\" instead."
        }
    }
}
