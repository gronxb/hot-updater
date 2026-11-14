package com.hotupdater

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Whether the spinner turns: the system's animator scale at 0 means animations are off. */
internal fun hotUpdaterSandboxSpinnerTurns(animatorDurationScale: Float): Boolean = animatorDurationScale > 0f

/**
 * Something runs with no progress to show, such as a check: an indeterminate
 * ring the size of iOS's activity indicator, in its gray. It holds still while
 * the system has animations turned off.
 */
@Composable
internal fun SandboxSpinner(modifier: Modifier = Modifier) {
    val colors = LocalSandboxColors.current
    val context = LocalContext.current
    val turns =
        remember(context) {
            hotUpdaterSandboxSpinnerTurns(
                Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f),
            )
        }
    val turn =
        if (turns) {
            rememberInfiniteTransition(label = "spinner")
                .animateFloat(
                    initialValue = 0f,
                    targetValue = 360f,
                    animationSpec = infiniteRepeatable(tween(durationMillis = 900, easing = LinearEasing)),
                    label = "turn",
                ).value
        } else {
            0f
        }
    Canvas(modifier.size(20.dp).semantics { progressBarRangeInfo = ProgressBarRangeInfo.Indeterminate }) {
        val stroke = 2.dp.toPx()
        rotate(turn) {
            drawArc(
                color = colors.muted,
                startAngle = -90f,
                sweepAngle = 270f,
                useCenter = false,
                topLeft = Offset(stroke / 2, stroke / 2),
                size = Size(size.width - stroke, size.height - stroke),
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
    }
}
