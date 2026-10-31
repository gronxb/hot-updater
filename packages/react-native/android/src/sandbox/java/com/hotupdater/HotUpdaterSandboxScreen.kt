package com.hotupdater

import android.app.AlertDialog
import android.content.res.Configuration
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * A plain placeholder until the sandbox's real screen: the current channel and
 * bundle, an Open button, and every question the coordinator asks. It only
 * renders [HotUpdaterSandboxState] and calls the coordinator's actions.
 */
internal class HotUpdaterSandboxScreen(
    private val activity: HotUpdaterSandboxActivity,
    private val coordinator: HotUpdaterSandboxCoordinator,
) {
    private val channel = label(18f)
    private val bundle = label(14f)
    private val status = label(14f)
    private val open =
        Button(activity).apply {
            text = OPEN
            setOnClickListener { coordinator.open() }
        }
    private var dialog: AlertDialog? = null
    private var dialogPhase: HotUpdaterSandboxPhase? = null

    val view: View =
        LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
            setBackgroundColor(if (isNight()) 0xFF0C0D0F.toInt() else 0xFFF5F6F8.toInt())
            addView(label(22f).apply { text = activity.applicationInfo.loadLabel(activity.packageManager) })
            addView(label(14f).apply { text = "Sandbox" })
            addView(channel, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = padding })
            addView(bundle)
            addView(status, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = padding })
            addView(open, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { topMargin = padding })
        }

    fun render(state: HotUpdaterSandboxState) {
        channel.text = state.selection?.let { "Channel: ${it.channel}" } ?: "Channel:"
        bundle.text =
            state.selection?.let {
                if (it.isBuiltIn) "Bundle: built-in" else "Bundle: ${it.bundleId}"
            } ?: "Bundle:"
        val working = state.phase is HotUpdaterSandboxPhase.Working
        open.isEnabled = !working
        open.text = if (activity.isOverApp) BACK else OPEN
        status.text = statusOf(state)
        ask(state.phase)
    }

    private fun statusOf(state: HotUpdaterSandboxState): String =
        when (val phase = state.phase) {
            is HotUpdaterSandboxPhase.Working ->
                when (phase.step) {
                    HotUpdaterSandboxStep.PREFLIGHT -> "Checking ${phase.target}…"
                    HotUpdaterSandboxStep.RESET -> "Removing downloaded bundles…"
                    HotUpdaterSandboxStep.CHECK -> "Checking ${phase.target}…"
                    HotUpdaterSandboxStep.DOWNLOAD ->
                        "Downloading ${phase.target}… ${((phase.progress ?: 0.0) * 100).toInt()}%"
                }
            is HotUpdaterSandboxPhase.WaitingForServer ->
                "${phase.link.channel} needs an answer from your update server first. Open the app so it can check for updates."
            else -> if (state.hasServerConfig) "" else "No update server yet. Open the app so it can check for updates."
        }

    private fun ask(phase: HotUpdaterSandboxPhase) {
        if (phase == dialogPhase) return
        dialogPhase = phase
        dialog?.dismiss()
        dialog = null
        val builder = AlertDialog.Builder(activity).setCancelable(false)
        when (phase) {
            is HotUpdaterSandboxPhase.Confirming ->
                builder
                    .setTitle("Open ${phase.link.channel}?")
                    .setMessage("This replaces the running bundle and deletes downloaded bundles.")
                    .setNegativeButton("Cancel") { _, _ ->
                        coordinator.dismiss()
                        activity.closeOverApp()
                    }.setPositiveButton("Open") { _, _ -> coordinator.confirmLink() }
            is HotUpdaterSandboxPhase.Refused ->
                builder
                    .setTitle(titleOf(phase.refusal))
                    .setMessage(messageOf(phase.refusal))
                    .setPositiveButton("OK") { _, _ ->
                        coordinator.dismiss()
                        activity.closeOverApp()
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
        dialog = builder.show()
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

    private fun label(size: Float) =
        TextView(activity).apply {
            textSize = size
            gravity = Gravity.CENTER
            setTextColor(if (isNight()) 0xFFF2F3F5.toInt() else 0xFF1A1C1F.toInt())
        }

    private fun isNight() =
        activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    private companion object {
        const val OPEN = "Open"
        const val BACK = "Back to the app"
    }
}
