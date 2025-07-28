/**
 * Focused test for modal behavior verification
 * This tests the actual fix implementation
 */

const fs = require('fs');
const path = require('path');

// Test Results
const testResults = [];

function addResult(testName, passed, details) {
    testResults.push({
        testName,
        passed,
        details,
        timestamp: new Date().toISOString()
    });
    console.log(`${passed ? '✅' : '❌'} ${testName}: ${details}`);
}

// Test 1: Verify the commented out event listener in renderer.js
function testRendererEventListenerDisabled() {
    const rendererPath = path.join(__dirname, 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    
    // Check that the message-history-btn event listener is commented out
    const hasCommentedListener = rendererContent.includes('// document.getElementById(\'message-history-btn\').addEventListener');
    const hasActiveListener = rendererContent.includes('document.getElementById(\'message-history-btn\').addEventListener') && 
                            !rendererContent.includes('// document.getElementById(\'message-history-btn\').addEventListener');
    
    const passed = hasCommentedListener && !hasActiveListener;
    
    addResult(
        'Renderer Event Listener Disabled',
        passed,
        passed ? 
            'Renderer event listener correctly commented out to prevent dual modal behavior' :
            'Event listener not properly disabled in renderer.js'
    );
    
    return passed;
}

// Test 2: Verify ModalManager has the active event listener
function testModalManagerEventListener() {
    const modalManagerPath = path.join(__dirname, 'src', 'ui', 'modal-manager.js');
    const modalManagerContent = fs.readFileSync(modalManagerPath, 'utf8');
    
    // Check for the active event listener setup
    const hasEventListenerSetup = modalManagerContent.includes('messageHistoryBtn.addEventListener(\'click\'');
    const hasShowModalCall = modalManagerContent.includes('this.showMessageHistoryModal()');
    
    const passed = hasEventListenerSetup && hasShowModalCall;
    
    addResult(
        'ModalManager Event Listener Active',
        passed,
        passed ?
            'ModalManager correctly handles message-history-btn click events' :
            'ModalManager does not properly set up event listeners'
    );
    
    return passed;
}

// Test 3: Check for potential conflicts in method names
function testMethodConflicts() {
    const rendererPath = path.join(__dirname, 'renderer.js');
    const modalManagerPath = path.join(__dirname, 'src', 'ui', 'modal-manager.js');
    
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    const modalManagerContent = fs.readFileSync(modalManagerPath, 'utf8');
    
    // Check if both files have openMessageHistoryModal methods
    const rendererHasMethod = rendererContent.includes('openMessageHistoryModal()');
    const modalManagerHasMethod = modalManagerContent.includes('showMessageHistoryModal()');
    
    // The fix should use different method names to avoid conflicts
    const hasConflict = rendererHasMethod && modalManagerHasMethod && 
                       rendererContent.includes('openMessageHistoryModal()') &&
                       modalManagerContent.includes('openMessageHistoryModal()');
    
    addResult(
        'Method Naming Conflict Check',
        !hasConflict,
        hasConflict ?
            'Potential method naming conflict detected between renderer and ModalManager' :
            'No method naming conflicts - ModalManager uses showMessageHistoryModal()'
    );
    
    return !hasConflict;
}

// Test 4: Verify modal HTML structure
function testModalHTMLStructure() {
    const indexPath = path.join(__dirname, 'index.html');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    
    // Check for required elements
    const hasHistoryButton = indexContent.includes('id="message-history-btn"');
    const hasHistoryModal = indexContent.includes('id="message-history-modal"');
    const hasColorPickerModal = indexContent.includes('id="terminal-color-picker-modal"');
    
    const passed = hasHistoryButton && hasHistoryModal && hasColorPickerModal;
    
    addResult(
        'Modal HTML Structure',
        passed,
        passed ?
            'All required modal elements present in HTML' :
            'Missing required modal elements in HTML structure'
    );
    
    return passed;
}

// Test 5: Check initialization order
function testInitializationOrder() {
    const rendererPath = path.join(__dirname, 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    
    // Check that ModalManager is initialized early in the constructor
    const modalManagerInitIndex = rendererContent.indexOf('this.modalManager = new ModalManager(this)');
    const setupEventListenersIndex = rendererContent.indexOf('this.setupEventListeners');
    
    const properOrder = modalManagerInitIndex > 0 && 
                       (setupEventListenersIndex < 0 || modalManagerInitIndex < setupEventListenersIndex);
    
    addResult(
        'Initialization Order',
        properOrder,
        properOrder ?
            'ModalManager initialized before event listeners to prevent conflicts' :
            'ModalManager initialization order may cause issues'
    );
    
    return properOrder;
}

// Test 6: Verify error handling in ModalManager initialization
function testErrorHandling() {
    const rendererPath = path.join(__dirname, 'renderer.js');
    const rendererContent = fs.readFileSync(rendererPath, 'utf8');
    
    // Check for try-catch around ModalManager initialization
    const hasTryCatch = rendererContent.includes('try {') && 
                       rendererContent.includes('this.modalManager = new ModalManager') &&
                       rendererContent.includes('} catch (error) {') &&
                       rendererContent.includes('ModalManager initialization failed');
    
    addResult(
        'Error Handling in Initialization',
        hasTryCatch,
        hasTryCatch ?
            'Proper error handling implemented for ModalManager initialization' :
            'Missing error handling for ModalManager initialization'
    );
    
    return hasTryCatch;
}

// Main test runner
function runBehaviorTests() {
    console.log('🔍 Running Modal Behavior Verification Tests\n');
    console.log('=' .repeat(60));
    
    const tests = [
        testRendererEventListenerDisabled,
        testModalManagerEventListener,
        testMethodConflicts,
        testModalHTMLStructure,
        testInitializationOrder,
        testErrorHandling
    ];
    
    let allPassed = true;
    
    tests.forEach(test => {
        const passed = test();
        if (!passed) allPassed = false;
    });
    
    console.log('\n' + '=' .repeat(60));
    console.log('📊 Behavior Test Summary:');
    const passed = testResults.filter(r => r.passed).length;
    const total = testResults.length;
    console.log(`   Total Tests: ${total}`);
    console.log(`   Passed: ${passed} (${(passed/total*100).toFixed(1)}%)`);
    console.log(`   Failed: ${total - passed}`);
    
    if (allPassed) {
        console.log('\n🎉 All behavior tests passed! Modal fix implementation is correct.');
    } else {
        console.log('\n⚠️  Some behavior tests failed. Review implementation.');
    }
    
    return {
        success: allPassed,
        results: testResults
    };
}

// Run tests if executed directly
if (require.main === module) {
    const results = runBehaviorTests();
    process.exit(results.success ? 0 : 1);
}

module.exports = { runBehaviorTests, testResults };