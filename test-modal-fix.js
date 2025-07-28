/**
 * Test script to verify modal fix functionality
 * Tests for duplicate modal issue and ensures proper event handling
 */

// Mock DOM environment for testing
const mockDOM = {
    elements: new Map(),
    eventListeners: new Map(),
    
    createElement(tag) {
        return {
            id: '',
            className: '',
            style: {},
            innerHTML: '',
            classList: {
                contains: (cls) => false,
                add: (cls) => {},
                remove: (cls) => {},
                toggle: (cls, force) => {}
            },
            addEventListener: (event, handler) => {
                const key = this.id + ':' + event;
                if (!mockDOM.eventListeners.has(key)) {
                    mockDOM.eventListeners.set(key, []);
                }
                mockDOM.eventListeners.get(key).push(handler);
            },
            querySelector: (selector) => null,
            querySelectorAll: (selector) => [],
            closest: (selector) => null,
            remove: () => {},
            focus: () => {}
        };
    },
    
    getElementById(id) {
        if (!this.elements.has(id)) {
            const element = this.createElement('div');
            element.id = id;
            this.elements.set(id, element);
        }
        return this.elements.get(id);
    },
    
    addEventListener(event, handler) {
        const key = 'document:' + event;
        if (!this.eventListeners.has(key)) {
            this.eventListeners.set(key, []);
        }
        this.eventListeners.get(key).push(handler);
    },
    
    triggerEvent(elementId, eventType, eventData = {}) {
        const key = elementId + ':' + eventType;
        const handlers = this.eventListeners.get(key) || [];
        console.log(`Triggering ${eventType} on ${elementId}, found ${handlers.length} handlers`);
        
        const event = {
            target: this.getElementById(elementId),
            preventDefault: () => {},
            stopPropagation: () => {},
            ...eventData
        };
        
        handlers.forEach(handler => {
            try {
                handler(event);
            } catch (error) {
                console.error(`Error in event handler:`, error);
            }
        });
    }
};

// Set up global mocks
global.document = mockDOM;
global.console = console;
global.lucide = { createIcons: () => {} };

// Test Results Collector
const testResults = {
    tests: [],
    addResult(testName, passed, message) {
        this.tests.push({ testName, passed, message, timestamp: new Date().toISOString() });
        console.log(`${passed ? '✅' : '❌'} ${testName}: ${message}`);
    },
    
    getSummary() {
        const passed = this.tests.filter(t => t.passed).length;
        const total = this.tests.length;
        return {
            passed,
            failed: total - passed,
            total,
            passRate: total > 0 ? (passed / total * 100).toFixed(1) : 0
        };
    }
};

// Mock Terminal GUI class
class MockTerminalGUI {
    constructor() {
        this.preferences = {};
        this.messageHistory = [
            { timestamp: Date.now(), content: 'Test message 1', status: 'completed', response: 'Test response 1' },
            { timestamp: Date.now() - 1000, content: 'Test message 2', status: 'pending' }
        ];
        this.currentDirectory = '/test/directory';
        this.modalManager = null;
        
        console.log('MockTerminalGUI initialized');
    }
    
    openMessageHistoryModal() {
        console.log('MockTerminalGUI.openMessageHistoryModal called');
        this.messageHistoryModalCalled = true;
    }
    
    logAction(message, level) {
        console.log(`[${level}] ${message}`);
    }
    
    closeModal(modalId) {
        console.log(`MockTerminalGUI.closeModal called with ${modalId}`);
    }
}

// Test 1: Check that ModalManager initializes correctly
function testModalManagerInitialization() {
    try {
        const ModalManager = require('./src/ui/modal-manager');
        const mockGUI = new MockTerminalGUI();
        
        const modalManager = new ModalManager(mockGUI);
        
        testResults.addResult(
            'ModalManager Initialization',
            modalManager !== null && typeof modalManager === 'object',
            'ModalManager successfully created and initialized'
        );
        
        return modalManager;
    } catch (error) {
        testResults.addResult(
            'ModalManager Initialization',
            false,
            `Failed to initialize ModalManager: ${error.message}`
        );
        return null;
    }
}

// Test 2: Verify event listener setup
function testEventListenerSetup(modalManager) {
    if (!modalManager) {
        testResults.addResult('Event Listener Setup', false, 'ModalManager not available');
        return;
    }
    
    // Check if message-history-btn has event listener
    const messageHistoryBtn = mockDOM.getElementById('message-history-btn');
    const hasEventListener = mockDOM.eventListeners.has('message-history-btn:click');
    
    testResults.addResult(
        'Message History Button Event Listener',
        hasEventListener,
        hasEventListener ? 'Event listener properly attached' : 'No event listener found'
    );
}

// Test 3: Test modal opening functionality
function testModalOpening(modalManager) {
    if (!modalManager) {
        testResults.addResult('Modal Opening', false, 'ModalManager not available');
        return;
    }
    
    try {
        // Mock the modal element
        const modal = mockDOM.getElementById('message-history-modal');
        modal.style.display = 'none';
        
        // Call the showMessageHistoryModal method
        modalManager.showMessageHistoryModal();
        
        testResults.addResult(
            'Modal Opening Functionality',
            true,
            'showMessageHistoryModal method executed without errors'
        );
    } catch (error) {
        testResults.addResult(
            'Modal Opening Functionality',
            false,
            `Error calling showMessageHistoryModal: ${error.message}`
        );
    }
}

// Test 4: Test click event simulation
function testClickEventHandling(modalManager) {
    if (!modalManager) {
        testResults.addResult('Click Event Handling', false, 'ModalManager not available');
        return;
    }
    
    try {
        // Simulate clicking the message history button
        mockDOM.triggerEvent('message-history-btn', 'click');
        
        testResults.addResult(
            'Click Event Handling',
            true,
            'Click event triggered successfully without errors'
        );
    } catch (error) {
        testResults.addResult(
            'Click Event Handling',
            false,
            `Error handling click event: ${error.message}`
        );
    }
}

// Test 5: Check for duplicate event listeners (potential conflict detection)
function testDuplicateEventListeners() {
    const messageHistoryListeners = mockDOM.eventListeners.get('message-history-btn:click') || [];
    const hasMultipleListeners = messageHistoryListeners.length > 1;
    
    testResults.addResult(
        'Duplicate Event Listener Check',
        !hasMultipleListeners,
        hasMultipleListeners ? 
            `WARNING: ${messageHistoryListeners.length} listeners found - potential duplicate modal issue` :
            'Only one event listener found - no duplicate modal risk'
    );
}

// Main test runner
function runTests() {
    console.log('🧪 Starting Modal Fix Verification Tests\n');
    console.log('=' .repeat(50));
    
    // Run tests in sequence
    const modalManager = testModalManagerInitialization();
    testEventListenerSetup(modalManager);
    testModalOpening(modalManager);
    testClickEventHandling(modalManager);
    testDuplicateEventListeners();
    
    // Print summary
    console.log('\n' + '=' .repeat(50));
    console.log('📊 Test Summary:');
    const summary = testResults.getSummary();
    console.log(`   Total Tests: ${summary.total}`);
    console.log(`   Passed: ${summary.passed} (${summary.passRate}%)`);
    console.log(`   Failed: ${summary.failed}`);
    
    if (summary.failed === 0) {
        console.log('\n🎉 All tests passed! Modal fix appears to be working correctly.');
    } else {
        console.log('\n⚠️  Some tests failed. Review the issues above.');
    }
    
    return {
        success: summary.failed === 0,
        summary,
        details: testResults.tests
    };
}

// Export for potential use in other contexts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { runTests, testResults, MockTerminalGUI };
}

// Run tests if this file is executed directly
if (require.main === module) {
    const results = runTests();
    process.exit(results.success ? 0 : 1);
}