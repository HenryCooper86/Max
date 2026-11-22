package io.github.henrycooper86.max.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.henrycooper86.max.ui.theme.Visor
import io.github.henrycooper86.max.ui.theme.VisorMotion
import io.github.henrycooper86.max.ui.theme.VisorShapes
import io.github.henrycooper86.max.ui.theme.VisorSpace
import io.github.henrycooper86.max.ui.theme.VisorType

// Shared Visor primitives. Everything here reads tokens from theme/Theme.kt.

/** A flat card: surface1 fill, 16dp radius, 1dp hairline (or a semantic border). */
@Composable
internal fun VisorCard(
    modifier: Modifier = Modifier,
    borderColor: Color? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val c = Visor.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(VisorShapes.card)
            .background(c.surface1)
            .border(Visor.metrics.lineWidth, borderColor ?: c.line, VisorShapes.card)
            .padding(VisorSpace.x4),
        verticalArrangement = Arrangement.spacedBy(VisorSpace.x2)
    ) {
        CompositionLocalProvider(LocalContentColor provides c.text) { content() }
    }
}

internal enum class VisorButtonStyle { PRIMARY, SECONDARY, GHOST, DANGER }

/** 48dp-minimum button. PRIMARY is the one accent-filled action on a surface. */
@Composable
internal fun VisorButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: VisorButtonStyle = VisorButtonStyle.SECONDARY,
    enabled: Boolean = true,
    icon: ImageVector? = null
) {
    val c = Visor.colors
    val (bg, fg) = when (style) {
        VisorButtonStyle.PRIMARY -> c.accent to c.onAccent
        VisorButtonStyle.SECONDARY -> c.surface3 to c.text
        VisorButtonStyle.GHOST -> Color.Transparent to c.text
        VisorButtonStyle.DANGER -> c.dangerSoft to c.danger
    }
    Row(
        modifier = modifier
            .heightIn(min = 48.dp)
            .alpha(if (enabled) 1f else Visor.metrics.disabledOpacity)
            .clip(VisorShapes.control)
            .background(bg)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = VisorSpace.x4, vertical = VisorSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VisorSpace.x2, Alignment.CenterHorizontally)
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(20.dp))
        Text(text, color = fg, style = VisorType.body.copy(fontWeight = FontWeight.SemiBold), maxLines = 2)
    }
}

/** Selectable pill (filters, toggles). Accent-soft fill + accent text when selected. */
@Composable
internal fun VisorChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selectedColor: Color = Visor.colors.accent
) {
    val c = Visor.colors
    val bg by animateColorAsState(
        if (selected) c.soft(selectedColor) else c.surface2,
        tween(VisorMotion.FAST, easing = VisorMotion.easeOut), label = "chipBg"
    )
    val fg = if (selected) selectedColor else c.textSecondary
    Box(
        modifier = modifier
            .minimumInteractiveComponentSize()
            .semantics { role = Role.Button; this.selected = selected }
            .clip(VisorShapes.pill)
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = VisorSpace.x3, vertical = VisorSpace.x2),
        contentAlignment = Alignment.Center
    ) {
        Text(label, color = fg, style = VisorType.label, maxLines = 1)
    }
}

/** Read-only status pill (battery, language...). */
@Composable
internal fun VisorTag(label: String, tint: Color = Visor.colors.textSecondary) {
    Box(
        Modifier
            .clip(VisorShapes.pill)
            .background(Visor.colors.surface2)
            .padding(horizontal = VisorSpace.x3, vertical = VisorSpace.x1 + 1.dp)
    ) { Text(label, color = tint, style = VisorType.caption, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

// ---- grouped settings list -------------------------------------------------------------

/**
 * Section header + a single rounded container whose rows are separated by 1dp
 * hairlines (the container colour shows through the gaps), instead of one card per row.
 */
@Composable
internal fun SettingsGroup(
    title: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val c = Visor.colors
    Column(verticalArrangement = Arrangement.spacedBy(VisorSpace.x2)) {
        if (title != null) {
            Text(
                title,
                color = c.textTertiary,
                style = VisorType.caption.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
                modifier = Modifier.padding(horizontal = VisorSpace.x1)
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(VisorShapes.card)
                .background(c.line)
                .border(Visor.metrics.lineWidth, c.line, VisorShapes.card),
            verticalArrangement = Arrangement.spacedBy(Visor.metrics.lineWidth)
        ) { content() }
        if (footer != null) {
            Text(footer, color = c.textTertiary, style = VisorType.caption, modifier = Modifier.padding(horizontal = VisorSpace.x1))
        }
    }
}

/** One row of a [SettingsGroup]: title (+ optional supporting text) and a trailing slot. */
@Composable
internal fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    supportingColor: Color = Visor.colors.textSecondary,
    titleColor: Color = Visor.colors.text,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    trailing: (@Composable RowScope.() -> Unit)? = null
) {
    val c = Visor.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(c.surface1)
            .then(if (onClick != null) Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick) else Modifier)
            .alpha(if (enabled) 1f else Visor.metrics.disabledOpacity)
            .heightIn(min = 56.dp)
            .padding(horizontal = VisorSpace.x4, vertical = VisorSpace.x3),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(VisorSpace.x3)
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = titleColor, style = VisorType.body)
            if (supporting != null) Text(supporting, color = supportingColor, style = VisorType.caption)
        }
        trailing?.invoke(this)
    }
}

/** Free-form row for text fields, notes and other content inside a [SettingsGroup]. */
@Composable
internal fun SettingsBlock(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Visor.colors.surface1)
            .padding(horizontal = VisorSpace.x4, vertical = VisorSpace.x3),
        verticalArrangement = Arrangement.spacedBy(VisorSpace.x2),
        content = content
    )
}

@Composable
internal fun ChevronIcon() {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = Visor.colors.textTertiary,
        modifier = Modifier.size(20.dp)
    )
}

/** Trailing value text + chevron, for navigational/action rows. */
@Composable
internal fun RowScope.ValueChevron(value: String? = null) {
    if (value != null) Text(value, color = Visor.colors.textSecondary, style = VisorType.bodySmall, maxLines = 1)
    ChevronIcon()
}

/**
 * Segmented control. Each segment is a 48dp-high touch slot with a 40dp visual;
 * selected = accent-soft fill with accent text.
 */
@Composable
internal fun <T> SegmentedControl(
    options: List<T>,
    selected: T?,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: (T) -> Boolean = { true },
    fill: Boolean = false,
    selectedColor: ((T) -> Color)? = null
) {
    val c = Visor.colors
    Row(
        modifier = modifier
            .clip(VisorShapes.control)
            .background(c.surface2)
            .border(Visor.metrics.lineWidth, c.line, VisorShapes.control)
    ) {
        options.forEach { option ->
            val isSelected = option == selected
            val tint = selectedColor?.invoke(option) ?: c.accent
            val bg by animateColorAsState(
                if (isSelected) c.soft(tint) else Color.Transparent,
                tween(VisorMotion.FAST, easing = VisorMotion.easeOut), label = "segBg"
            )
            val isEnabled = enabled(option)
            Box(
                modifier = Modifier
                    // Equal widths would clip longer (English) labels, so weight by label length.
                    .then(if (fill) Modifier.weight(label(option).length + 4f) else Modifier)
                    .heightIn(min = 48.dp)
                    .semantics { role = Role.RadioButton; this.selected = isSelected }
                    .clickable(enabled = isEnabled) { onSelect(option) }
                    .padding(3.dp),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    Modifier
                        .heightIn(min = 40.dp)
                        .clip(VisorShapes.control)
                        .background(bg)
                        .padding(horizontal = VisorSpace.x3),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        label(option),
                        color = if (isSelected) tint else if (isEnabled) c.textSecondary else c.textTertiary,
                        style = VisorType.label,
                        maxLines = 1
                    )
                }
            }
        }
    }
}

/** A settings row with the label above a full-width scrollable segmented control (many/long options). */
@Composable
internal fun <T> SegmentedRow(
    title: String,
    options: List<T>,
    selected: T?,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    fill: Boolean = true,
    selectedColor: ((T) -> Color)? = null
) {
    SettingsBlock {
        Text(title, color = Visor.colors.text, style = VisorType.body)
        if (fill) {
            SegmentedControl(options, selected, label, onSelect, modifier = Modifier.fillMaxWidth(), fill = true, selectedColor = selectedColor)
        } else {
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                SegmentedControl(options, selected, label, onSelect, selectedColor = selectedColor)
            }
        }
    }
}

@Composable
internal fun visorSwitchColors() = Visor.colors.let {
    SwitchDefaults.colors(
        checkedThumbColor = it.onAccent,
        checkedTrackColor = it.accent,
        checkedBorderColor = it.accent,
        uncheckedThumbColor = it.textSecondary,
        uncheckedTrackColor = it.surface3,
        uncheckedBorderColor = it.lineStrong,
        disabledCheckedTrackColor = it.accent.copy(alpha = 0.4f),
        disabledUncheckedTrackColor = it.surface2,
        disabledUncheckedBorderColor = it.line
    )
}

@Composable
internal fun SettingsSwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
    supporting: String? = null
) {
    SettingsRow(title, supporting = supporting, enabled = enabled, onClick = { onCheckedChange(!checked) }) {
        Switch(checked = checked, onCheckedChange = null, enabled = enabled, colors = visorSwitchColors())
    }
}

@Composable
internal fun visorTextFieldColors() = Visor.colors.let {
    OutlinedTextFieldDefaults.colors(
        focusedTextColor = it.text,
        unfocusedTextColor = it.text,
        disabledTextColor = it.textTertiary,
        focusedBorderColor = it.accent,
        unfocusedBorderColor = it.lineStrong,
        disabledBorderColor = it.line,
        focusedLabelColor = it.accent,
        unfocusedLabelColor = it.textSecondary,
        disabledLabelColor = it.textTertiary,
        cursorColor = it.accent,
        focusedContainerColor = it.surface2,
        unfocusedContainerColor = it.surface2,
        disabledContainerColor = it.surface2
    )
}

@Composable
internal fun VisorTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    secret: Boolean = false,
    visualTransformation: VisualTransformation? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    mono: Boolean = false,
    keyboardActions: KeyboardActions = KeyboardActions.Default
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = true,
        label = { Text(label, style = VisorType.caption) },
        textStyle = if (mono) VisorType.mono else VisorType.body,
        shape = VisorShapes.control,
        colors = visorTextFieldColors(),
        visualTransformation = visualTransformation ?: if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        modifier = modifier.fillMaxWidth()
    )
}

/** Dialog styled with surface2 / 24dp. Buttons are VisorButtons supplied by the caller. */
@Composable
internal fun VisorAlertDialog(
    onDismissRequest: () -> Unit,
    title: String,
    text: @Composable (() -> Unit)?,
    confirmButton: @Composable () -> Unit,
    dismissButton: @Composable (() -> Unit)? = null
) {
    val c = Visor.colors
    AlertDialog(
        onDismissRequest = onDismissRequest,
        containerColor = c.surface2,
        titleContentColor = c.text,
        textContentColor = c.textSecondary,
        shape = VisorShapes.sheetAll,
        title = { Text(title, style = VisorType.title) },
        text = text,
        confirmButton = confirmButton,
        dismissButton = dismissButton
    )
}

/** Dialog body paragraph. */
@Composable
internal fun DialogText(text: String) =
    Text(text, color = Visor.colors.textSecondary, style = VisorType.bodySmall)

/** 1dp hairline. */
@Composable
internal fun VisorDivider(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(Visor.metrics.lineWidth).background(Visor.colors.line))
}
