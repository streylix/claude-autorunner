# Claude Autorunner Color Palette

A comprehensive color system for the claude-autorunner application with dark theme (default) and Catppuccin Latte light theme.

## Core Backgrounds

| Name | Dark | Light | Usage |
|------|------|-------|-------|
| Primary Background | `#1a1a1e` | `#eff1f5` | Main container, panels, base layer |
| Secondary Background | `#121214` | `#e6e9ef` | Deepest chrome, terminal areas, dense layouts |
| Tertiary Background | `#222228` | `#dce0e8` | Card surfaces, input backgrounds, elevated elements |
| Quaternary Background | `#2a2a32` | `#ccd0da` | Hover states, subtle emphasis, interactive elements |

## Text & Hierarchy

| Name | Dark | Light | Usage |
|------|------|-------|-------|
| Primary Text | `#e8e8ed` | `#4c4f69` | Body text, primary labels, high contrast |
| Secondary Text | `#c2c2c9` | `#5c5f77` | Secondary labels, timestamps, descriptions |
| Tertiary Text | `#a0a0ab` | `#6c6f85` | Hints, helper text, reduced prominence |
| Quaternary Text | `#6b6b76` | `#7c7f93` | Disabled text, placeholders, minimal contrast |

## Borders & Dividers

| Name | Dark | Light | Usage |
|------|------|-------|-------|
| Primary Border | `#33333c` | `#dce0e8` | Subtle dividers |
| Secondary Border | `#44444f` | `#ccd0da` | Emphasized dividers |

## Semantic & Intent Colors

| Name | Dark | Light | Usage |
|------|------|-------|-------|
| Primary / Interactive | `#4f8ff7` | `#1e66f5` | Primary actions, focus states, buttons |
| Secondary | `#3a6fd0` | `#04a5e5` | Hover, active states |
| Success | `#34d399` | `#40a02b` | Success states, completion |
| Warning | `#fbbf24` | `#df8e1d` | In-progress, attention, running state |
| Error | `#f87171` | `#d20f39` | Errors, destructive actions |
| Magenta | `#ff69b4` | `#ea76cb` | Accent, injecting state |
| Purple | `#A7B0ED` | `#8839ef` | Prompted state, accent |

## ANSI Terminal Colors (8-color)

| Color | Hex |
|-------|-----|
| Black | `#000000` |
| Red | `#ff5f57` |
| Green | `#28ca42` |
| Yellow | `#ffbe2e` |
| Blue | `#4f8ff7` |
| Magenta | `#af52de` |
| Cyan | `#5ac8fa` |
| White | `#ffffff` |

## Bright Terminal Colors (8-color+)

| Color | Hex |
|-------|-----|
| Bright Black | `#6b6b76` |
| Bright Red | `#ff6e67` |
| Bright Green | `#32d74b` |
| Bright Yellow | `#ffcc02` |
| Bright Blue | `#007aff` |
| Bright Magenta | `#bf5af2` |
| Bright Cyan | `#64d8ff` |
| Bright White | `#ffffff` |

## Terminal Instance Colors (24-color palette)

Colors used for individual terminal tab indicators (Terminal 1–24):

| Terminal | Hex | Terminal | Hex | Terminal | Hex | Terminal | Hex |
|----------|-----|----------|-----|----------|-----|----------|-----|
| 1 | `#4f8ff7` | 7 | `#ff6b9d` | 13 | `#ef5350` | 19 | `#9ccc65` |
| 2 | `#28ca42` | 8 | `#4ecdc4` | 14 | `#ab47bc` | 20 | `#ff7043` |
| 3 | `#ff5f57` | 9 | `#ffa726` | 15 | `#ffc107` | 21 | `#5c6bc0` |
| 4 | `#ffbe2e` | 10 | `#7986cb` | 16 | `#42a5f5` | 22 | `#29b6f6` |
| 5 | `#af52de` | 11 | `#26c6da` | 17 | `#26a69a` | 23 | `#78909c` |
| 6 | `#5ac8fa` | 12 | `#66bb6a` | 18 | `#ec407a` | 24 | `#8bc34a` |

## CSS Custom Properties

Use these in your stylesheets for theme-aware styling:

```css
:root {
  /* Backgrounds */
  --bg-primary: #1a1a1e;
  --bg-secondary: #121214;
  --bg-tertiary: #222228;
  --bg-quaternary: #2a2a32;

  /* Text */
  --text-primary: #e8e8ed;
  --text-secondary: #c2c2c9;
  --text-tertiary: #a0a0ab;
  --text-quaternary: #6b6b76;

  /* Borders */
  --border-primary: #33333c;
  --border-secondary: #44444f;

  /* Semantic Colors */
  --accent-primary: #4f8ff7;
  --accent-secondary: #3a6fd0;
  --accent-success: #34d399;
  --accent-warning: #fbbf24;
  --accent-error: #f87171;
  --accent-magenta: #ff69b4;
  --accent-purple: #A7B0ED;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg-primary: #eff1f5;
    --bg-secondary: #e6e9ef;
    --bg-tertiary: #dce0e8;
    --bg-quaternary: #ccd0da;
    --text-primary: #4c4f69;
    --text-secondary: #5c5f77;
    --text-tertiary: #6c6f85;
    --text-quaternary: #7c7f93;
    --border-primary: #dce0e8;
    --border-secondary: #ccd0da;
    --accent-primary: #1e66f5;
    --accent-secondary: #04a5e5;
    --accent-success: #40a02b;
    --accent-warning: #df8e1d;
    --accent-error: #d20f39;
    --accent-magenta: #ea76cb;
    --accent-purple: #8839ef;
  }
}
```

## Design Principles

**Depth Through Lightness** — The system uses four lightness steps rather than shadows: secondary (deepest) → primary → tertiary → quaternary (most elevated). This creates visual hierarchy without blur or artificial shadow layers.

**Terminal Work Takes Priority** — Terminal content sits on the darkest background (secondary) so the work itself, not the surrounding chrome, holds visual attention.

**Semantic Color Encoding** — Colors encode state and intent:
- **Blue** → primary interaction, focus
- **Purple** → prompted state
- **Magenta** → injecting state
- **Yellow** → running/in-progress
- **Red** → errors
- **Green** → success

**Dual Themes** — Dark theme (default) maintains the app's primary aesthetic with cool graphite tones. Light theme uses Catppuccin Latte, a warm, sophisticated palette. Both maintain the same semantic intent and visual hierarchy.

**Terminal Color Sets** — The 24-color instance palette provides distinct visual identification for concurrent terminals while staying harmonious as a set.
