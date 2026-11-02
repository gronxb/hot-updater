package com.hotupdater

import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.provider.MediaStore
import android.text.InputType
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.ViewTreeObserver
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import kotlin.math.abs

private const val TAG = "HotUpdaterSandbox"
private const val ACCENT = 0xFFF97316.toInt()
private const val GREEN = 0xFF22C55E.toInt()
private const val RED = 0xFFEF4444.toInt()
private const val HELP_URL = "https://hot-updater.dev/docs/native-builds/sandbox"

/**
 * The first screen, and the same screen over a running app. It renders
 * [HotUpdaterSandboxState] and calls the coordinator's actions. Reads only:
 * opening it sends the update server nothing.
 */
internal class HotUpdaterSandboxScreen(
    private val activity: HotUpdaterSandboxActivity,
    private val coordinator: HotUpdaterSandboxCoordinator,
    private val devServer: HotUpdaterSandboxDevServer,
) {
    private data class Palette(
        val page: Int,
        val surface: Int,
        val border: Int,
        val text: Int,
        val secondary: Int,
        val tertiary: Int,
    )

    private val isNight =
        activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    private val colors =
        if (isNight) {
            Palette(
                0xFF0C0D0F.toInt(),
                0xFF1A1C1F.toInt(),
                0xFF2A2D31.toInt(),
                0xFFF2F3F5.toInt(),
                0xFFA3A9B2.toInt(),
                0xFF6E747C.toInt(),
            )
        } else {
            Palette(
                0xFFF5F6F8.toInt(),
                Color.WHITE,
                0xFFE3E5E8.toInt(),
                0xFF1A1C1F.toInt(),
                0xFF5F6670.toInt(),
                0xFF8C929B.toInt(),
            )
        }

    private var currentTab = 0
    private var state = coordinator.state
    private var shownHome: HotUpdaterSandboxHomeModel? = null
    private var shownInfo: HotUpdaterSandboxInfoModel? = null
    private var dialog: AlertDialog? = null
    private var dialogPhase: HotUpdaterSandboxPhase? = null
    private val urlEntry = Entry("Enter URL manually", "192.168.0.10:8081", "Connect", ::connect)
    private val channelEntry = Entry("Enter a channel", "pr-123", "Open") { coordinator.switchTo(it) }
    private val tabBody = FrameLayout(activity)
    private val tabBar = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
    private val headerClose =
        FrameLayout(activity).apply {
            background = rounded(colors.surface, 10, colors.border)
            contentDescription = "Back to the app"
            addView(
                text("✕", 15f, colors.secondary).apply { gravity = Gravity.CENTER },
                FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT),
            )
            setOnClickListener {
                coordinator.acknowledgeLastLaunch()
                activity.finish()
            }
        }
    private val homeSections = vertical()
    private val infoGroups = vertical()
    private val infoReset = text("Reset to built-in bundle", 16f, RED).apply { setPadding(dp(16), dp(14), dp(16), dp(14)) }
    private val homePage: View
    private val infoPage: View

    val view: View

    init {
        homePage =
            vertical().apply {
                addView(header())
                addView(scrolling(homeSections), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            }
        infoPage = scrolling(infoContent())
        tabBody.addView(homePage, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        tabBody.addView(infoPage, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        view =
            Root().apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(colors.page)
                setOnApplyWindowInsetsListener { view, insets ->
                    @Suppress("DEPRECATION")
                    view.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
                    insets
                }
                addView(tabBody, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
                addView(tabBar, LinearLayout.LayoutParams(MATCH_PARENT, dp(64)))
            }
        showTab(0)
        devServer.onDevServerChange = {
            shownHome = null
            render(state)
        }
    }

    /**
     * A tap outside a text field takes the keyboard away. Only after the tap
     * reached what's under it: earlier, the page would move a button from under
     * the finger.
     */
    private inner class Root : LinearLayout(activity) {
        private var downX = 0f
        private var downY = 0f

        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
            if (event.action == MotionEvent.ACTION_DOWN) {
                downX = event.rawX
                downY = event.rawY
            }
            val handled = super.dispatchTouchEvent(event)
            if (event.action == MotionEvent.ACTION_UP) {
                val focused = activity.currentFocus as? EditText
                val isTap = abs(event.rawX - downX) < dp(16) && abs(event.rawY - downY) < dp(16)
                if (focused != null && isTap) {
                    val bounds = Rect()
                    focused.getGlobalVisibleRect(bounds)
                    if (!bounds.contains(event.rawX.toInt(), event.rawY.toInt())) hideKeyboard(focused)
                }
            }
            return handled
        }

        /** Takes the touch nothing else wants, or its end never comes here. */
        @Suppress("ClickableViewAccessibility")
        override fun onTouchEvent(event: MotionEvent) = true
    }

    fun render(next: HotUpdaterSandboxState) {
        state = next
        val runningHost = devServer.runningDevServerHost
        headerClose.visibility = if (activity.isOverApp) View.VISIBLE else View.GONE
        val home = HotUpdaterSandboxHomeModel.of(next, activity.isOverApp, runningHost, System.currentTimeMillis())
        if (home != shownHome) {
            shownHome = home
            homeSections.removeAllViews()
            fillHome(home)
        }
        val info = HotUpdaterSandboxInfoModel.of(next, versionText(), configuration(), activity.isOverApp, runningHost)
        if (info != shownInfo) {
            shownInfo = info
            fillInfo(info)
        }
        val canReset = next.hasServerConfig && next.phase !is HotUpdaterSandboxPhase.Working
        infoReset.isEnabled = canReset
        infoReset.alpha = if (canReset) 1f else 0.5f
        ask(next.phase)
    }

    // MARK: view helpers

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    private fun text(
        value: String,
        size: Float,
        color: Int,
        bold: Boolean = false,
        lines: Int = 1,
    ) = TextView(activity).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        if (lines > 0) maxLines = lines
        ellipsize = if (lines > 0) TextUtils.TruncateAt.END else null
    }

    private fun icon(
        resource: Int,
        color: Int,
        size: Int = 20,
    ) = ImageView(activity).apply {
        setImageResource(resource)
        imageTintList = ColorStateList.valueOf(color)
        layoutParams = LinearLayout.LayoutParams(dp(size), dp(size))
    }

    private fun rounded(
        fill: Int,
        radius: Int,
        stroke: Int? = null,
    ) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun horizontal() =
        LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

    private fun vertical() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    private fun LinearLayout.addWeighted(child: View) = addView(child, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))

    private fun LinearLayout.addSpaced(
        child: View,
        top: Int,
    ) {
        addView(child, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(top) })
    }

    private fun card(vararg rows: View): LinearLayout {
        val group = vertical()
        group.background = rounded(colors.surface, 14, colors.border)
        group.clipToOutline = true
        rows.forEachIndexed { index, row ->
            if (index > 0) {
                group.addView(View(activity).apply { setBackgroundColor(colors.border) }, LinearLayout.LayoutParams(MATCH_PARENT, dp(1)))
            }
            group.addView(row)
        }
        return group
    }

    private fun caption(
        title: String,
        action: String? = null,
        onAction: (() -> Unit)? = null,
    ): View {
        val line = horizontal()
        line.setPadding(dp(4), 0, dp(4), 0)
        line.addWeighted(text(title, 14f, colors.secondary, bold = true))
        if (action != null) {
            line.addView(
                text(action.uppercase(), 12f, ACCENT, bold = true).apply {
                    letterSpacing = 0.08f
                    setOnClickListener { onAction?.invoke() }
                },
            )
        }
        return line
    }

    private fun dot(color: Int) =
        View(activity).apply {
            background =
                GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                }
            layoutParams = LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(14) }
        }

    private fun row(
        lead: View?,
        title: String,
        subtitle: String? = null,
        detail: String? = null,
        enabled: Boolean = true,
        onTap: () -> Unit,
    ): View {
        val line = horizontal()
        line.setPadding(dp(16), dp(14), dp(16), dp(14))
        if (lead != null) line.addView(lead)
        val texts = vertical()
        texts.addView(text(title, 17f, colors.text, bold = true))
        if (subtitle != null) texts.addView(text(subtitle, 14f, colors.secondary))
        if (detail != null) texts.addView(text(detail, 12f, colors.tertiary))
        line.addWeighted(texts)
        line.addView(icon(R.drawable.hot_updater_sandbox_chevron, colors.tertiary, 16))
        line.isEnabled = enabled
        line.alpha = if (enabled) 1f else 0.5f
        line.setOnClickListener { if (enabled) onTap() }
        return line
    }

    /** A window that just got a dialog back ignores the request until it has focus again. */
    private fun showKeyboard(field: EditText) {
        val keyboard = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        field.requestFocus()
        if (field.hasWindowFocus()) {
            keyboard.showSoftInput(field, 0)
            return
        }
        val observer = field.viewTreeObserver
        observer.addOnWindowFocusChangeListener(
            object : ViewTreeObserver.OnWindowFocusChangeListener {
                override fun onWindowFocusChanged(hasFocus: Boolean) {
                    if (!hasFocus) return
                    field.viewTreeObserver.removeOnWindowFocusChangeListener(this)
                    if (field.isFocused) field.post { keyboard.showSoftInput(field, 0) }
                }
            },
        )
    }

    private fun hideKeyboard(field: EditText) {
        val keyboard = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        keyboard.hideSoftInputFromWindow(field.windowToken, 0)
        field.clearFocus()
    }

    /** An expanding "enter" row. It outlives a redraw, so what's typed stays. */
    private inner class Entry(
        title: String,
        hint: String,
        action: String,
        private val submit: (String) -> Unit,
    ) {
        private val arrow = icon(R.drawable.hot_updater_sandbox_chevron, colors.text, 16)
        private val field =
            EditText(activity).apply {
                this.hint = hint
                setHintTextColor(colors.tertiary)
                setTextColor(colors.text)
                textSize = 16f
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                imeOptions = EditorInfo.IME_ACTION_GO
                background = rounded(colors.page, 8, colors.border)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setOnEditorActionListener { _, id, _ ->
                    if (id == EditorInfo.IME_ACTION_GO) send()
                    id == EditorInfo.IME_ACTION_GO
                }
            }
        private val form =
            vertical().apply {
                setPadding(dp(16), 0, dp(16), dp(16))
                addView(field)
                addSpaced(
                    text(action, 16f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        background = rounded(ACCENT, 10)
                        setPadding(0, dp(12), 0, dp(12))
                        setOnClickListener { send() }
                    },
                    10,
                )
            }
        val view: View =
            vertical().apply {
                addView(
                    horizontal().apply {
                        setPadding(dp(16), dp(14), dp(16), dp(14))
                        addView(arrow)
                        addView(
                            text(title, 16f, colors.text),
                            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(12) },
                        )
                        setOnClickListener { setExpanded(form.visibility != View.VISIBLE) }
                    },
                )
                addView(form)
            }

        init {
            setExpanded(false, keyboard = false)
            view.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> revealIfFocused() }
        }

        /** The whole form stays above the keyboard, not only the field. */
        fun revealIfFocused() {
            if (!field.isFocused) return
            view.post {
                val page = ancestorScroll(view) ?: return@post
                val bounds = Rect(0, 0, form.width, form.height)
                page.offsetDescendantRectToMyCoords(form, bounds)
                val bottom = bounds.bottom + dp(12)
                val visible = page.scrollY + page.height
                if (bottom > visible) page.smoothScrollTo(0, bottom - page.height)
            }
        }

        private fun ancestorScroll(child: View): ScrollView? {
            var parent = child.parent
            while (parent != null && parent !is ScrollView) parent = parent.parent
            return parent as? ScrollView
        }

        fun setExpanded(
            open: Boolean,
            keyboard: Boolean = true,
        ) {
            form.visibility = if (open) View.VISIBLE else View.GONE
            arrow.rotation = if (open) 90f else 0f
            if (!keyboard) return
            if (open) showKeyboard(field) else hideKeyboard(field)
        }

        private fun send() {
            val value = field.text.toString().trim()
            if (value.isEmpty()) return
            field.setText("")
            setExpanded(false)
            submit(value)
        }
    }

    private fun detached(view: View): View {
        (view.parent as? ViewGroup)?.removeView(view)
        return view
    }

    // MARK: tabs

    private fun showTab(index: Int) {
        currentTab = index
        homePage.visibility = if (index == 0) View.VISIBLE else View.GONE
        infoPage.visibility = if (index == 1) View.VISIBLE else View.GONE
        tabBar.removeAllViews()
        tabBar.setBackgroundColor(colors.surface)
        tabBar.addView(tabItem(0, "Home", R.drawable.hot_updater_sandbox_home), LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
        tabBar.addView(tabItem(1, "Info", R.drawable.hot_updater_sandbox_info), LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
    }

    private fun tabItem(
        index: Int,
        title: String,
        resource: Int,
    ): View {
        val active = index == currentTab
        val color = if (active) ACCENT else colors.secondary
        val item = vertical()
        item.gravity = Gravity.CENTER
        item.addView(icon(resource, color, 24))
        item.addView(text(title, 12f, color, bold = active).apply { gravity = Gravity.CENTER })
        item.setOnClickListener { showTab(index) }
        return item
    }

    private fun scrolling(content: LinearLayout): View {
        content.setPadding(dp(16), dp(16), dp(16), dp(24))
        return ScrollView(activity).apply {
            isFillViewport = true
            addView(content)
            // The keyboard shrinks the page without laying out what's in it.
            addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
                urlEntry.revealIfFocused()
                channelEntry.revealIfFocused()
            }
        }
    }

    // MARK: Home

    private fun header(): View {
        val line = horizontal()
        line.setBackgroundColor(colors.surface)
        line.setPadding(dp(16), dp(10), dp(16), dp(10))
        val packageManager = activity.packageManager
        line.addView(
            ImageView(activity).apply {
                setImageDrawable(activity.applicationInfo.loadIcon(packageManager))
                layoutParams = LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(12) }
            },
        )
        val names = vertical()
        names.addView(text(activity.applicationInfo.loadLabel(packageManager).toString(), 18f, colors.text, bold = true))
        names.addView(text("Sandbox · ${versionText()}", 12f, colors.secondary))
        line.addWeighted(names)
        line.addView(headerClose, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(8) })
        return line
    }

    private fun fillHome(model: HotUpdaterSandboxHomeModel) {
        val content = homeSections
        model.status?.let {
            content.addView(statusCard(it))
            content.addView(View(activity), LinearLayout.LayoutParams(MATCH_PARENT, dp(20)))
        }
        model.banner?.let {
            content.addView(bannerCard(it))
            content.addView(View(activity), LinearLayout.LayoutParams(MATCH_PARENT, dp(20)))
        }
        content.addView(caption(model.bigRow.caption))
        content.addSpaced(card(primaryRow(model)), 8)
        addDevServer(content, model)
        addPreviews(content, model)
        content.addSpaced(
            text(HotUpdaterSandboxHomeModel.HINT, 13f, colors.secondary, lines = 0).apply { setPadding(dp(4), 0, dp(4), 0) },
            18,
        )
    }

    private fun statusCard(status: HotUpdaterSandboxHomeModel.Status): View {
        val column = vertical()
        column.setPadding(dp(16), dp(14), dp(16), dp(14))
        column.addView(text(status.text, 15f, colors.text, lines = 0))
        status.progress?.let { progress ->
            column.addSpaced(
                ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100
                    this.progress = (progress * 100).toInt()
                    progressTintList = ColorStateList.valueOf(ACCENT)
                },
                10,
            )
        }
        return card(column)
    }

    private fun bannerCard(banner: HotUpdaterSandboxHomeModel.Banner): View {
        val line = horizontal()
        line.setPadding(dp(16), dp(14), dp(16), dp(14))
        line.addView(
            icon(R.drawable.hot_updater_sandbox_warning, ACCENT, 22).apply {
                (layoutParams as LinearLayout.LayoutParams).marginEnd =
                    dp(12)
            },
        )
        line.addWeighted(text(banner.text, 15f, colors.text, lines = 0))
        if (!banner.offersReset) return card(line)
        return card(
            line,
            text("Reset to built-in bundle", 15f, RED, bold = true).apply {
                setPadding(dp(16), dp(14), dp(16), dp(14))
                setOnClickListener { coordinator.resetToBuiltIn() }
            },
        )
    }

    private fun primaryRow(model: HotUpdaterSandboxHomeModel): View {
        val tile = FrameLayout(activity)
        tile.background = rounded(ACCENT, 10)
        tile.layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(12) }
        tile.addView(
            icon(
                if (model.bigRow.isReload) R.drawable.hot_updater_sandbox_reload else R.drawable.hot_updater_sandbox_play,
                Color.WHITE,
                24,
            ),
            FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER),
        )
        return row(tile, model.bigRow.title, model.bigRow.subtitle, model.bigRow.detail, enabled = !model.isBusy) {
            when {
                !model.bigRow.isReload -> coordinator.open()
                devServer.isRunningDevServer -> devServer.reloadDevServer()
                else -> coordinator.reloadApp()
            }
        }
    }

    private fun addDevServer(
        content: LinearLayout,
        model: HotUpdaterSandboxHomeModel,
    ) {
        content.addSpaced(
            caption("Dev server", "Help") {
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(HELP_URL))) }
            },
            22,
        )
        val rows = ArrayList<View>()
        val running = devServer.runningDevServerHost
        if (running != null) {
            rows += row(dot(GREEN), running, "Dev server running") { devServer.reloadDevServer() }
            rows += row(null, "Exit dev server") { devServer.exitDevServer() }
        } else {
            devServer.devServerHosts.forEach { host ->
                rows +=
                    row(
                        dot(if (host.isRunning == true) GREEN else colors.tertiary),
                        host.address,
                        when (host.isRunning) {
                            true -> "Dev server running"
                            false -> "Not running. Start your dev server, then tap to retry."
                            null -> "Tap to connect"
                        },
                        enabled = !model.isBusy,
                    ) { connect(host.address) }
            }
            rows += detached(urlEntry.view)
        }
        content.addSpaced(card(*rows.toTypedArray()), 8)
    }

    private fun connect(host: String) {
        devServer.connect(host) { problem ->
            if (problem != null) {
                alertBuilder()
                    .setTitle("Couldn't connect to $host")
                    .setMessage(problem)
                    .setPositiveButton("OK", null)
                    .show()
                    .accented()
            }
        }
    }

    private fun addPreviews(
        content: LinearLayout,
        model: HotUpdaterSandboxHomeModel,
    ) {
        content.addSpaced(
            if (model.previews.isEmpty()) {
                caption("OTA previews")
            } else {
                caption("OTA previews", "Clear") { coordinator.clearHistory() }
            },
            22,
        )
        val rows = ArrayList<View>()
        val scan = horizontal()
        scan.setPadding(dp(16), dp(14), dp(16), dp(14))
        scan.addView(icon(R.drawable.hot_updater_sandbox_qr, colors.text, 18))
        scan.addView(
            text("Scan QR code", 16f, colors.text),
            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(12) },
        )
        scan.setOnClickListener { openCamera() }
        rows += scan
        model.previewHint?.let { rows += text(it, 15f, colors.secondary, lines = 0).apply { setPadding(dp(16), dp(14), dp(16), dp(14)) } }
        model.previews.forEach { preview ->
            rows +=
                row(dot(colors.tertiary), preview.channel, preview.message, preview.opened, enabled = !model.isBusy) {
                    coordinator.switchTo(preview.channel)
                }
        }
        rows += detached(channelEntry.view)
        content.addSpaced(card(*rows.toTypedArray()), 8)
        content.addSpaced(
            text(HotUpdaterSandboxHomeModel.SWITCH_NOTE, 13f, colors.secondary, lines = 0).apply { setPadding(dp(4), 0, dp(4), 0) },
            8,
        )
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
            alertBuilder()
                .setTitle("No camera app")
                .setMessage("Paste the preview link into \"Enter a channel\" instead.")
                .setPositiveButton("OK", null)
                .show()
                .accented()
        }
    }

    // MARK: Info

    private fun infoContent(): LinearLayout {
        val content = vertical()
        content.addView(text("Info", 28f, colors.text, bold = true).apply { setPadding(dp(4), 0, 0, 0) })
        content.addSpaced(infoGroups, 18)
        infoReset.setOnClickListener { coordinator.resetToBuiltIn() }
        content.addSpaced(card(infoReset), 22)
        content.addSpaced(
            text(HotUpdaterSandboxHomeModel.RESET_NOTE, 13f, colors.secondary, lines = 0).apply { setPadding(dp(4), 0, dp(4), 0) },
            8,
        )
        return content
    }

    private fun fillInfo(model: HotUpdaterSandboxInfoModel) {
        infoGroups.removeAllViews()
        infoGroups.addView(caption("Build"))
        infoGroups.addSpaced(card(*model.build.map(::pair).toTypedArray()), 8)
        infoGroups.addSpaced(caption("Bundle"), 22)
        infoGroups.addSpaced(card(*model.bundle.map(::pair).toTypedArray()), 8)
    }

    private fun pair(entry: HotUpdaterSandboxInfoModel.Row): View {
        val line = horizontal()
        line.setPadding(dp(16), dp(13), dp(16), dp(13))
        line.addWeighted(text(entry.name, 16f, colors.text))
        line.addView(text(entry.value, 16f, colors.secondary))
        return line
    }

    private fun versionText(): String {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        @Suppress("DEPRECATION")
        return "${info.versionName} (${info.versionCode})"
    }

    private fun configuration() = if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) "Debug" else "Release"

    // MARK: questions

    private fun alertBuilder() =
        AlertDialog.Builder(
            activity,
            if (isNight) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert,
        )

    private fun AlertDialog.accented(): AlertDialog {
        getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(ACCENT)
        getButton(AlertDialog.BUTTON_NEGATIVE)?.setTextColor(colors.secondary)
        return this
    }

    private fun ask(phase: HotUpdaterSandboxPhase) {
        if (phase == dialogPhase) return
        dialogPhase = phase
        dialog?.dismiss()
        dialog = null
        val builder = alertBuilder().setCancelable(false)
        when (phase) {
            is HotUpdaterSandboxPhase.Confirming ->
                builder
                    .setTitle("Open ${phase.link.channel}?")
                    .setMessage("This replaces the running bundle and deletes downloaded bundles.")
                    .setNegativeButton("Cancel") { _, _ ->
                        coordinator.dismiss(activity::closeOverApp)
                    }.setPositiveButton("Open") { _, _ -> coordinator.confirmLink() }
            is HotUpdaterSandboxPhase.Refused ->
                builder
                    .setTitle(titleOf(phase.refusal))
                    .setMessage(messageOf(phase.refusal))
                    .setPositiveButton("OK") { _, _ ->
                        coordinator.dismiss(activity::closeOverApp)
                    }
            is HotUpdaterSandboxPhase.Failed ->
                builder
                    .setTitle("Couldn't open ${phase.target}")
                    .setMessage(
                        "${messageOf(phase.failure, phase.target)}\n\nSelected now: ${phase.selection.channel}, " +
                            "${if (phase.selection.isBuiltIn) "built-in bundle" else "bundle ${phase.selection.bundleId}"}.",
                    ).setNegativeButton("Close") { _, _ -> coordinator.dismiss() }
                    .setPositiveButton("Retry") { _, _ -> coordinator.retry() }
            else -> return
        }
        dialog = builder.show().accented()
    }

    private fun titleOf(refusal: HotUpdaterSandboxRefusal): String =
        when (refusal) {
            is HotUpdaterSandboxRefusal.Unreadable -> "This link can't be read"
            is HotUpdaterSandboxRefusal.InvalidChannel -> "That isn't a channel name"
            is HotUpdaterSandboxRefusal.OtherFingerprint -> "${refusal.link.channel} needs another build"
        }

    private fun messageOf(refusal: HotUpdaterSandboxRefusal): String =
        when (refusal) {
            is HotUpdaterSandboxRefusal.Unreadable -> "It isn't a preview link for this app."
            is HotUpdaterSandboxRefusal.InvalidChannel -> "Check \"${refusal.channel}\" and try again."
            is HotUpdaterSandboxRefusal.OtherFingerprint ->
                "Its native code differs from this build. Install the sandbox build for that fingerprint."
        }

    private fun messageOf(
        failure: HotUpdaterSandboxFailure,
        target: String,
    ): String =
        when (failure) {
            HotUpdaterSandboxFailure.NoBundle -> "$target has no bundle for this build."
            HotUpdaterSandboxFailure.ResetFailed -> "Downloaded bundles couldn't be removed."
            HotUpdaterSandboxFailure.Superseded -> "Another update check changed the selection first."
            is HotUpdaterSandboxFailure.Error -> failure.message
        }
}
