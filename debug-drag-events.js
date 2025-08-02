// Debug script to test drag functionality
// Run this in browser console to diagnose drag issues

console.log('🔍 Drag Debug Script Starting...');

// Check if message elements exist and are draggable
const messageItems = document.querySelectorAll('.message-item');
console.log(`Found ${messageItems.length} message items`);

messageItems.forEach((item, index) => {
    console.log(`Message ${index}:`, {
        draggable: item.draggable,
        dataset: item.dataset,
        hasListeners: item.getAttribute('data-drag-listeners-added')
    });
});

// Check container listeners
const messageList = document.getElementById('message-list');
console.log('Message list container:', {
    exists: !!messageList,
    hasListeners: messageList?.getAttribute('data-drag-listeners-added'),
    childCount: messageList?.children.length
});

// Add test event listeners to see what's happening
if (messageList) {
    const testDragStart = (e) => {
        console.log('🎯 DRAGSTART EVENT:', {
            target: e.target,
            currentTarget: e.currentTarget,
            closestMessage: e.target.closest('.message-item'),
            isButton: !!e.target.closest('button'),
            tagName: e.target.tagName
        });
    };

    const testDragOver = (e) => {
        console.log('🔄 DRAGOVER EVENT:', {
            target: e.target,
            closestMessage: e.target.closest('.message-item')
        });
    };

    // Remove existing listeners and add debug ones
    messageList.removeEventListener('dragstart', testDragStart);
    messageList.removeEventListener('dragover', testDragOver);
    
    messageList.addEventListener('dragstart', testDragStart, true);
    messageList.addEventListener('dragover', testDragOver, true);
    
    console.log('✅ Debug listeners added to message-list');
}

// Test manual drag trigger
console.log('🧪 Testing manual drag event...');
if (messageItems.length > 0) {
    const firstMessage = messageItems[0];
    const dragEvent = new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer()
    });
    
    console.log('Manual drag event result:', firstMessage.dispatchEvent(dragEvent));
}

console.log('🔍 Debug script complete. Check console for drag event logs.');