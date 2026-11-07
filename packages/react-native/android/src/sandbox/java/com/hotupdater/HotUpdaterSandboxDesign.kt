package com.hotupdater

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.Image as FoundationImage

// The tokens and components of SANDBOX_DESIGN.md, which iOS's
// HotUpdaterSandboxDesign.swift draws the same way.

internal data class SandboxColors(
    val background: Color,
    val surface: Color,
    val surfacePressed: Color,
    val fill: Color,
    val separator: Color,
    val text: Color,
    val textSecondary: Color,
    val muted: Color,
    val success: Color,
    val danger: Color,
) {
    val accent = Color(0xFFF97316)
    val accentPressed = Color(0xFFEA580C)

    companion object {
        val light =
            SandboxColors(
                background = Color(0xFFF2F2F7),
                surface = Color(0xFFFFFFFF),
                surfacePressed = Color(0xFFE5E5EA),
                fill = Color(0xFFEFEFF4),
                separator = Color(0xFFC6C6C8),
                text = Color(0xFF000000),
                textSecondary = Color(0xFF6C6C70),
                muted = Color(0xFF8E8E93),
                success = Color(0xFF34C759),
                danger = Color(0xFFFF3B30),
            )
        val dark =
            SandboxColors(
                background = Color(0xFF000000),
                surface = Color(0xFF1C1C1E),
                surfacePressed = Color(0xFF2C2C2E),
                fill = Color(0xFF2C2C2E),
                separator = Color(0xFF38383A),
                text = Color(0xFFFFFFFF),
                textSecondary = Color(0xFF98989F),
                muted = Color(0xFF8E8E93),
                success = Color(0xFF30D158),
                danger = Color(0xFFFF453A),
            )
    }
}

/** Geist for the interface, Geist Mono for what's code-like. A script Geist lacks falls back to the system font. */
internal object SandboxType {
    private val sans =
        FontFamily(
            Font(R.font.hot_updater_sandbox_geist_regular, FontWeight.Normal),
            Font(R.font.hot_updater_sandbox_geist_medium, FontWeight.Medium),
            Font(R.font.hot_updater_sandbox_geist_semibold, FontWeight.SemiBold),
        )
    private val mono =
        FontFamily(
            Font(R.font.hot_updater_sandbox_geist_mono_regular, FontWeight.Normal),
            Font(R.font.hot_updater_sandbox_geist_mono_medium, FontWeight.Medium),
        )

    private fun sans(
        size: Int,
        weight: FontWeight,
    ) = TextStyle(fontFamily = sans, fontWeight = weight, fontSize = size.sp)

    val title = sans(22, FontWeight.SemiBold)
    val headline = sans(17, FontWeight.SemiBold)
    val body = sans(17, FontWeight.Normal)
    val subhead = sans(15, FontWeight.Normal)
    val footnote = sans(13, FontWeight.Normal)
    val label = sans(13, FontWeight.SemiBold).copy(letterSpacing = 0.4.sp)
    val badge = sans(12, FontWeight.SemiBold)
    val codeHeadline = TextStyle(fontFamily = mono, fontWeight = FontWeight.Medium, fontSize = 15.sp)
    val code = TextStyle(fontFamily = mono, fontWeight = FontWeight.Normal, fontSize = 15.sp)
}

internal object SandboxMotion {
    fun <T> spring() = spring<T>(dampingRatio = 0.86f, stiffness = 320f)
}

internal val LocalSandboxColors = staticCompositionLocalOf { SandboxColors.light }

@Composable
internal fun SandboxTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) SandboxColors.dark else SandboxColors.light
    CompositionLocalProvider(LocalSandboxColors provides colors, content = content)
}

internal object SandboxHaptic {
    fun tap(view: View) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY,
        )
    }

    fun toggle(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    fun error(view: View) {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS,
        )
    }
}

// MARK: primitives

@Composable
internal fun SandboxText(
    text: String,
    style: TextStyle,
    color: Color = LocalSandboxColors.current.text,
    modifier: Modifier = Modifier,
    maxLines: Int = Int.MAX_VALUE,
    textAlign: TextAlign? = null,
) {
    BasicText(
        text = text,
        modifier = modifier,
        style = style.copy(color = color, textAlign = textAlign ?: TextAlign.Unspecified),
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
internal fun SandboxIcon(
    resource: Int,
    tint: Color,
    size: Dp = 20.dp,
    modifier: Modifier = Modifier,
) {
    FoundationImage(
        painter = painterResource(resource),
        contentDescription = null,
        colorFilter =
            androidx.compose.ui.graphics.ColorFilter
                .tint(tint),
        modifier = modifier.size(size),
    )
}

/** A pressed state of the design's own: the background turns at once and eases back. */
@Composable
internal fun Modifier.sandboxPressable(
    enabled: Boolean = true,
    role: Role = Role.Button,
    pressedColor: Color = LocalSandboxColors.current.surfacePressed,
    onClick: () -> Unit,
): Modifier {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val background by animateColorAsState(
        if (pressed) pressedColor else pressedColor.copy(alpha = 0f),
        animationSpec = if (pressed) snap() else tween(150),
        label = "pressed",
    )
    return this
        .background(background)
        .clickable(interactionSource = source, indication = null, enabled = enabled, role = role, onClick = onClick)
}

/** How large the text is set, from the font scale: the largest sizes stack what sits side by side. */
@Composable
internal fun isLargeText(): Boolean = androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.5f

@Composable
internal fun SandboxSection(
    title: String?,
    action: Pair<String, () -> Unit>? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalSandboxColors.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title != null) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SandboxText(
                    title.uppercase(),
                    SandboxType.label,
                    colors.textSecondary,
                    Modifier.weight(1f).semantics { heading() },
                )
                if (action != null) {
                    SandboxText(
                        action.first,
                        SandboxType.subhead,
                        colors.accent,
                        Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .sandboxPressable(pressedColor = colors.fill, onClick = action.second)
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                    )
                }
            }
        }
        content()
        if (footer != null) {
            SandboxText(footer, SandboxType.footnote, colors.textSecondary, Modifier.padding(horizontal = 16.dp))
        }
    }
}

@Composable
internal fun SandboxCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier =
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(LocalSandboxColors.current.surface),
        content = content,
    )
}

/** A hairline between rows, from where the row's text starts. */
@Composable
internal fun SandboxDivider(leading: Boolean = true) {
    Box(
        Modifier
            .padding(start = if (leading) (16 + 32 + 12).dp else 16.dp)
            .fillMaxWidth()
            .height(0.5.dp)
            .background(LocalSandboxColors.current.separator),
    )
}

internal sealed class SandboxLead {
    data class Icon(
        val resource: Int,
    ) : SandboxLead()

    data class Dot(
        val running: Boolean,
    ) : SandboxLead()

    data class Primary(
        val resource: Int,
    ) : SandboxLead()
}

@Composable
private fun SandboxLeadView(lead: SandboxLead) {
    val colors = LocalSandboxColors.current
    // The tiles grow with the text, as iOS's do with Dynamic Type.
    val scale =
        androidx.compose.ui.platform.LocalDensity.current.fontScale
            .coerceIn(1f, 1.6f)
    when (lead) {
        is SandboxLead.Icon ->
            Box(
                Modifier
                    .size(32.dp * scale)
                    .clip(RoundedCornerShape(8.dp))
                    .background(colors.fill),
                contentAlignment = Alignment.Center,
            ) { SandboxIcon(lead.resource, colors.textSecondary, 18.dp * scale) }
        is SandboxLead.Dot ->
            Box(Modifier.size(32.dp * scale), contentAlignment = Alignment.Center) {
                Box(
                    Modifier
                        .size(10.dp * scale)
                        .clip(CircleShape)
                        .background(if (lead.running) colors.success else colors.muted),
                )
            }
        is SandboxLead.Primary ->
            Box(
                Modifier
                    .size(40.dp * scale)
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.accent),
                contentAlignment = Alignment.Center,
            ) { SandboxIcon(lead.resource, Color.White, 22.dp * scale) }
    }
}

@Composable
internal fun SandboxRowContent(
    lead: SandboxLead?,
    title: String,
    titleStyle: TextStyle = SandboxType.body,
    subtitle: String? = null,
    detail: String? = null,
    detailStyle: TextStyle = SandboxType.footnote,
    trailing: (@Composable () -> Unit)? = null,
) {
    val colors = LocalSandboxColors.current
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val texts: @Composable () -> Unit = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SandboxText(title, titleStyle)
                if (subtitle != null) SandboxText(subtitle, SandboxType.subhead, colors.textSecondary)
                if (detail != null) SandboxText(detail, detailStyle, colors.textSecondary)
            }
        }
        if (isLargeText()) {
            // At the largest text the lead sits above the text, which then has the width.
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (lead != null) SandboxLeadView(lead)
                texts()
            }
        } else {
            if (lead != null) {
                SandboxLeadView(lead)
                Spacer(Modifier.width(12.dp))
            }
            Box(Modifier.weight(1f)) { texts() }
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        }
    }
}

@Composable
internal fun SandboxRow(
    lead: SandboxLead?,
    title: String,
    titleStyle: TextStyle = SandboxType.body,
    subtitle: String? = null,
    detail: String? = null,
    detailStyle: TextStyle = SandboxType.footnote,
    showsChevron: Boolean = true,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalSandboxColors.current
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.4f)
            .sandboxPressable(enabled = enabled, onClick = onClick),
    ) {
        SandboxRowContent(
            lead = lead,
            title = title,
            titleStyle = titleStyle,
            subtitle = subtitle,
            detail = detail,
            detailStyle = detailStyle,
            trailing =
                if (showsChevron) {
                    { SandboxIcon(R.drawable.hot_updater_sandbox_chevron, colors.muted, 18.dp) }
                } else {
                    null
                },
        )
    }
}

@Composable
internal fun SandboxDestructiveRow(
    title: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .sandboxPressable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        SandboxText(title, SandboxType.body, LocalSandboxColors.current.danger)
    }
}

@Composable
internal fun SandboxPrimaryButton(
    title: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalSandboxColors.current
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(RoundedCornerShape(10.dp))
            .background(colors.accent)
            .sandboxPressable(enabled = enabled, pressedColor = colors.accentPressed, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        SandboxText(title, SandboxType.headline, Color.White)
    }
}

@Composable
internal fun SandboxBadge(text: String) {
    val colors = LocalSandboxColors.current
    SandboxText(
        text,
        SandboxType.badge,
        colors.textSecondary,
        Modifier
            .clip(CircleShape)
            .background(colors.fill)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
internal fun SandboxField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    description: String,
    keyboardType: KeyboardType,
    focusRequester: FocusRequester,
    onGo: () -> Unit,
) {
    val colors = LocalSandboxColors.current
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = SandboxType.code.copy(color = colors.text),
        cursorBrush = SolidColor(colors.accent),
        keyboardOptions =
            KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = keyboardType,
                imeAction = ImeAction.Go,
            ),
        keyboardActions = KeyboardActions(onGo = { onGo() }),
        modifier =
            Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester)
                .onFocusChanged { focused = it.isFocused }
                .semantics { contentDescription = description },
        decorationBox = { field ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(colors.fill)
                    .border(if (focused) 2.dp else 0.dp, if (focused) colors.accent else Color.Transparent, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) SandboxText(placeholder, SandboxType.code, colors.muted)
                field()
            }
        },
    )
}

/** A row that opens a field and a button in its own card, on the design's spring. */
@Composable
internal fun SandboxAccordion(
    lead: SandboxLead,
    title: String,
    expanded: Boolean,
    enabled: Boolean = true,
    onToggle: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalSandboxColors.current
    val turn by animateFloatAsState(if (expanded) 180f else 0f, SandboxMotion.spring(), label = "chevron")
    Column(Modifier.fillMaxWidth().alpha(if (enabled) 1f else 0.4f)) {
        Box(
            Modifier
                .sandboxPressable(enabled = enabled, onClick = onToggle)
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
        ) {
            SandboxRowContent(lead = lead, title = title, trailing = {
                // The chevron points down, and turns up when open.
                SandboxIcon(R.drawable.hot_updater_sandbox_chevron, colors.muted, 18.dp, Modifier.rotate(90f + turn))
            })
        }
        AnimatedVisibility(
            visible = expanded,
            enter = expandVertically(SandboxMotion.spring(), expandFrom = Alignment.Top) + fadeIn(SandboxMotion.spring()),
            exit = shrinkVertically(SandboxMotion.spring(), shrinkTowards = Alignment.Top) + fadeOut(SandboxMotion.spring()),
        ) {
            Column(
                Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content,
            )
        }
    }
}

/** A question, in the design's card: text buttons, the main one in accent, a destructive one in danger. */
@Composable
internal fun SandboxDialog(
    title: String,
    message: String,
    confirm: String,
    destructive: Boolean = false,
    dismiss: String? = null,
    /** Whether Back and a tap outside cancel it: not for a question the coordinator waits on. */
    dismissible: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalSandboxColors.current
    Dialog(
        onDismissRequest = { if (dismissible) onDismiss() },
        properties = DialogProperties(dismissOnBackPress = dismissible, dismissOnClickOutside = dismissible),
    ) {
        Column(
            Modifier
                .widthIn(max = 400.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(colors.surface)
                .padding(top = 24.dp, start = 24.dp, end = 24.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SandboxText(title, SandboxType.headline, modifier = Modifier.semantics { heading() })
            SandboxText(message, SandboxType.subhead, colors.textSecondary)
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.End) {
                if (dismiss != null) DialogButton(dismiss, colors.textSecondary, onDismiss)
                DialogButton(confirm, if (destructive) colors.danger else colors.accent, onConfirm)
            }
        }
    }
}

/** A long text to read, such as a license, in the design's card: it scrolls, and Back closes it. */
@Composable
internal fun SandboxTextDialog(
    title: String,
    text: String,
    onClose: () -> Unit,
) {
    val colors = LocalSandboxColors.current
    Dialog(onDismissRequest = onClose) {
        Column(
            Modifier
                .widthIn(max = 560.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(colors.surface)
                .padding(top = 24.dp, start = 24.dp, end = 24.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SandboxText(title, SandboxType.headline, modifier = Modifier.semantics { heading() })
            Box(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                SandboxText(text, SandboxType.footnote, colors.textSecondary)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                DialogButton("Close", colors.accent, onClose)
            }
        }
    }
}

@Composable
private fun DialogButton(
    title: String,
    color: Color,
    onClick: () -> Unit,
) {
    SandboxText(
        title,
        SandboxType.headline,
        color,
        Modifier
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(10.dp))
            .sandboxPressable(pressedColor = LocalSandboxColors.current.fill, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 13.dp),
    )
}
