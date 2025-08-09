# Terminal Chunk Layout Investigation Report

## Problem Statement
**Issue**: 6 terminals are showing in one chunk instead of proper chunking with 2 terminals per chunk.

## Key Findings

### 1. Core Chunking Logic Location
- **File**: `renderer.js`
- **Main Function**: `organizeTerminalsIntoChunks()` (lines 8908-8952)
- **Supporting Function**: `updateTerminalLayout()` (lines 8954-8995)
- **Trigger Function**: `ensureScrollLayout()` (lines 8895-8906)

### 2. Chunking Algorithm
```javascript
// From organizeTerminalsIntoChunks()
const terminalsPerChunk = this.preferences.terminalsPerChunk || 4;
const chunksNeeded = Math.ceil(terminalWrappers.length / terminalsPerChunk);
```

### 3. Layout CSS Structure
- **CSS File**: `style.css`
- **Chunk Classes**: `.terminal-chunk.chunk-1` through `.terminal-chunk.chunk-8`
- **Layout Types**: 
  - `layout-scroll` (horizontal chunks)
  - `layout-scroll-vertical` (vertical chunks)

### 4. Configuration Controls
- **Slider Element**: `terminals-per-chunk` (found in renderer.js references)
- **Preference Key**: `terminalsPerChunk`
- **Default Value**: 4 terminals per chunk
- **Orientation Setting**: `chunkOrientation` ('horizontal' or 'vertical')

## Root Cause Analysis

### Likely Issues:
1. **Preference Loading Problem**: `this.preferences.terminalsPerChunk` may not be properly loaded from storage
2. **Slider Event Handler Issue**: The slider change event may not be updating the preference correctly
3. **Preference Persistence Issue**: Settings may not be saving to backend/localStorage properly

### Critical Code Points:
1. **Preference Retrieval**: Line 8920 in `organizeTerminalsIntoChunks()`
2. **Settings UI**: Lines 1788-1802 for slider event handlers
3. **Preference Loading**: Lines 7366-7374 in settings UI update

## Technical Details

### Function Flow:
1. `updateTerminalLayout()` determines if chunking is needed (5+ terminals)
2. Calls `ensureScrollLayout()` which reorganizes terminals
3. `organizeTerminalsIntoChunks()` divides terminals based on `terminalsPerChunk` preference
4. Each chunk gets class `terminal-chunk chunk-{numberOfTerminalsInChunk}`

### Expected vs Actual Behavior:
- **Expected**: With 6 terminals and 2 terminals per chunk → 3 chunks (chunk-2, chunk-2, chunk-2)  
- **Actual**: All 6 terminals in one chunk → 1 chunk (chunk-6)
- **Root Cause**: `terminalsPerChunk` is likely defaulting to 4+ instead of the user's preference of 2

## Recommended Investigation Steps
1. Check if preference loading mechanism is working (`loadAllPreferences()`)
2. Verify slider event handler is updating `this.preferences.terminalsPerChunk`
3. Confirm preference persistence to storage
4. Debug the actual value of `terminalsPerChunk` during chunk organization

## Files for Further Investigation
- `renderer.js` - Core logic implementation
- `style.css` - Layout styling for chunks
- `index.html` - Settings UI elements
- Backend preference storage mechanism