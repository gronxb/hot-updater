package com.hotupdater

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/**
 * Something runs with no progress to show, such as a check: an indeterminate
 * ring the size of iOS's activity indicator, in its gray. It holds still while
 * the system has animations turned off, as [SandboxTheme] follows it.
 */
@Composable
internal fun SandboxSpinner(modifier: Modifier = Modifier) {
    val colors = LocalSandboxColors.current
    // The theme follows the system's animations live: switched off, the ring stops where it is drawn.
    val turn =
        if (!LocalSandboxAnimationsOff.current) {
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
