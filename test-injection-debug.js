/**
 * Debug Script to Test Real Message Injection
 * This simulates what happens when you inject a message through the UI
 */

// Create a test message to inject (similar to what the UI does)
const testMessage = {
    id: Date.now() + Math.random(),
    content: 'debug test message from script',
    processedContent: 'debug test message from script',
    timestamp: Date.now(),
    createdAt: Date.now()
};

console.log('🔍 Testing message injection debug...');
console.log('Test message created:', testMessage);

// Check current active terminal ID
console.log('Current activeTerminalId:', window.terminalGUI?.activeTerminalId);

// Try to call saveToMessageHistory directly
if (window.terminalGUI && window.terminalGUI.saveToMessageHistory) {
    console.log('Calling saveToMessageHistory with activeTerminalId...');
    window.terminalGUI.saveToMessageHistory(testMessage, window.terminalGUI.activeTerminalId, 999);
} else {
    console.log('❌ terminalGUI or saveToMessageHistory not available');
}

// Wait a moment then check the backend
setTimeout(() => {
    console.log('Checking backend after injection...');
    fetch('http://localhost:8001/api/queue/history/')
        .then(response => response.json())
        .then(data => {
            console.log('Recent backend history:');
            data.slice(0, 3).forEach(item => {
                console.log(`- ${item.timestamp}: "${item.message}" (Terminal ${item.terminal_id})`);
            });
            
            const found = data.find(item => item.message === testMessage.content);
            if (found) {
                console.log('✅ Test message found in backend!', found);
            } else {
                console.log('❌ Test message NOT found in backend');
            }
        })
        .catch(error => {
            console.error('❌ Failed to check backend:', error);
        });
}, 2000);

console.log('Test script completed. Check console for results.');