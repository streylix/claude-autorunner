# TESTING REQUIREMENTS FOR CLAUDE FLOW WORKERS

## 🚨 CRITICAL: MANDATORY FOR ALL AI AGENTS 🚨

**ANY AI AGENT working on this Auto-Injector application MUST follow this testing protocol:**

### BEFORE ANY CODE CHANGES:
```bash
python test_auto_injector.py start connect wait 15 screenshot "before_change" [test actions] screenshot "after_change"
```

### REQUIRED VERIFICATION STEPS:
1. **Take before/after screenshots** - Document the change visually
2. **Read screenshots with AI vision** - Actually look at the images 
3. **Verify functionality works** - Confirm the change behaves as expected
4. **Check for regressions** - Ensure nothing else broke

### WHY THIS IS MANDATORY:
- **Complex application** with UI, timers, queues, terminal processes
- **Subtle interactions** that can break in non-obvious ways
- **Visual verification** is the only reliable confirmation method
- **Automated testing** prevents regressions and ensures quality

### COMMON TEST PATTERNS:
- **Button changes:** `click "button-test-id"`
- **Input changes:** `type "text" "input-test-id"`
- **Modal interactions:** `click "modal-btn" wait 2 screenshot "modal_open"`
- **Timer functionality:** Test setting and auto-injection
- **Queue operations:** Test message queuing and processing

### DATA-TEST-ID REQUIREMENTS:
- Every interactive element MUST have `data-test-id` attributes
- Use descriptive names: `timer-save-btn`, `settings-btn`, `send-btn`
- Add test IDs to any new UI elements you create

### ❌ NEVER COMPLETE TASKS WITHOUT:
- Running the test script successfully
- Taking and analyzing screenshots  
- Visually confirming the change works
- Verifying no regressions occurred

**This is non-negotiable for maintaining application stability and functionality.**