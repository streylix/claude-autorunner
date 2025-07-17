# Terminal Dropdown Keyboard Navigation Test

## New Features Added:

1. **Number Key Navigation (1-0)**
   - Press keys 1-9 to select terminals 1-9
   - Press 0 to select the 10th terminal
   - Selection is immediate after pressing the number key

2. **Type-to-Select**
   - Start typing the terminal name to jump to matching terminals
   - Matches are case-insensitive
   - Type buffer clears after 1 second of no typing
   - Backspace supported to correct typing

## How to Test:

1. Open the terminal dropdown using Cmd+K
2. Try these keyboard shortcuts:
   - **Number keys**: Press 1, 2, 3, etc. to jump to terminals
   - **Arrow keys**: Still work for sequential navigation
   - **Type to select**: Type "term" or terminal names
   - **Enter**: Select highlighted terminal
   - **Escape**: Close dropdown

## Implementation Details:

- Added to `setupTerminalSelectorKeyboard()` function
- Number keys check for modifier keys to avoid conflicts
- Type buffer maintains search string with 1-second timeout
- Auto-select after number key press (100ms delay)
- Clears type buffer on arrow key usage or dropdown close