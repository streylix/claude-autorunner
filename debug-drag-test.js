// Debug test script to check drag functionality
console.log('=== DRAG DEBUG TEST ===');

// Test 1: Check if message items are draggable
function testDraggableAttribute() {
    console.log('\n1. Testing draggable attributes:');
    const messageItems = document.querySelectorAll('.message-item');
    messageItems.forEach((item, index) => {
        console.log(`Message ${index}: draggable=${item.draggable}, hasAttribute=${item.hasAttribute('draggable')}`);
    });
}

// Test 2: Check CSS pointer-events
function testPointerEvents() {
    console.log('\n2. Testing pointer-events CSS:');
    const messageItems = document.querySelectorAll('.message-item');
    messageItems.forEach((item, index) => {
        const computedStyle = window.getComputedStyle(item);
        const actionsEl = item.querySelector('.message-actions');
        const actionsComputedStyle = actionsEl ? window.getComputedStyle(actionsEl) : null;
        
        console.log(`Message ${index}:`);
        console.log(`  - Item pointer-events: ${computedStyle.pointerEvents}`);
        console.log(`  - Actions pointer-events: ${actionsComputedStyle ? actionsComputedStyle.pointerEvents : 'N/A'}`);
        console.log(`  - Actions opacity: ${actionsComputedStyle ? actionsComputedStyle.opacity : 'N/A'}`);
    });
}

// Test 3: Check event listeners
function testEventListeners() {
    console.log('\n3. Testing event listeners:');
    const messageList = document.getElementById('message-list');
    console.log(`Message list has drag listeners: ${messageList.hasAttribute('data-drag-listeners-added')}`);
    
    // Try to trigger a dragstart event manually
    const firstMessage = document.querySelector('.message-item');
    if (firstMessage) {
        console.log('Attempting to trigger dragstart on first message...');
        const dragEvent = new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            dataTransfer: new DataTransfer()
        });
        const result = firstMessage.dispatchEvent(dragEvent);
        console.log(`Dragstart event result: ${result}`);
    }
}

// Test 4: Check for overlapping elements
function testElementOverlap() {
    console.log('\n4. Testing for overlapping elements:');
    const messageItems = document.querySelectorAll('.message-item');
    messageItems.forEach((item, index) => {
        const rect = item.getBoundingClientRect();
        const elementsAtPoint = document.elementsFromPoint(rect.left + rect.width/2, rect.top + rect.height/2);
        console.log(`Message ${index} center elements:`, elementsAtPoint.map(el => el.className).slice(0, 5));
    });
}

// Test 5: Check for preventDefault calls
function testPreventDefault() {
    console.log('\n5. Testing preventDefault behavior:');
    
    // Add temporary event listener to catch dragstart
    const tempListener = (e) => {
        console.log('Dragstart detected on:', e.target.className);
        console.log('Event defaultPrevented:', e.defaultPrevented);
        console.log('Target closest message-item:', !!e.target.closest('.message-item'));
        console.log('Target closest button:', !!e.target.closest('button'));
    };
    
    document.addEventListener('dragstart', tempListener, true);
    
    // Clean up after 5 seconds
    setTimeout(() => {
        document.removeEventListener('dragstart', tempListener, true);
        console.log('Temporary dragstart listener removed');
    }, 5000);
}

// Run all tests
function runAllTests() {
    testDraggableAttribute();
    testPointerEvents();
    testEventListeners();
    testElementOverlap();
    testPreventDefault();
    
    console.log('\n=== Tests complete. Try dragging a message now and watch console ===');
}

// Auto-run tests when script is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAllTests);
} else {
    runAllTests();
}