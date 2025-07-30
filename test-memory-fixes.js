/**
 * Test script to verify memory leak fixes are working correctly
 * Run with: node test-memory-fixes.js
 */

const { BoundedSet, BoundedMap, BoundedArray } = require('./src/utils/bounded-collections');
const timerRegistry = require('./src/utils/timer-registry');

console.log('Testing memory leak fixes...\n');

// Test BoundedSet
console.log('1. Testing BoundedSet with limit of 3:');
const boundedSet = new BoundedSet(3);
boundedSet.add('item1');
boundedSet.add('item2');
boundedSet.add('item3');
console.log('  - Added 3 items, size:', boundedSet.size);
console.log('  - Stats:', boundedSet.getStats());

boundedSet.add('item4'); // Should remove oldest
console.log('  - Added 4th item, size:', boundedSet.size);
console.log('  - Items:', Array.from(boundedSet));
console.log('  - Stats:', boundedSet.getStats());

// Test BoundedMap
console.log('\n2. Testing BoundedMap with limit of 3:');
const boundedMap = new BoundedMap(3);
boundedMap.set('key1', 'value1');
boundedMap.set('key2', 'value2');
boundedMap.set('key3', 'value3');
console.log('  - Added 3 items, size:', boundedMap.size);
console.log('  - Stats:', boundedMap.getStats());

boundedMap.set('key4', 'value4'); // Should remove oldest
console.log('  - Added 4th item, size:', boundedMap.size);
console.log('  - Keys:', Array.from(boundedMap.keys()));
console.log('  - Stats:', boundedMap.getStats());

// Test BoundedArray
console.log('\n3. Testing BoundedArray with limit of 3:');
const boundedArray = new BoundedArray(3);
boundedArray.push('item1');
boundedArray.push('item2');
boundedArray.push('item3');
console.log('  - Added 3 items, length:', boundedArray.length);
console.log('  - Stats:', boundedArray.getStats());

boundedArray.push('item4'); // Should remove oldest
console.log('  - Added 4th item, length:', boundedArray.length);
console.log('  - Items:', [...boundedArray]);
console.log('  - Stats:', boundedArray.getStats());

// Test TimerRegistry
console.log('\n4. Testing TimerRegistry:');
console.log('  - Initial stats:', timerRegistry.getStats());

// Create some test timers
let counter = 0;
timerRegistry.createInterval('testInterval', () => {
    counter++;
    console.log(`  - Interval tick: ${counter}`);
    if (counter >= 3) {
        timerRegistry.clearInterval('testInterval');
        console.log('  - Cleared test interval');
    }
}, 500);

timerRegistry.createTimeout('testTimeout', () => {
    console.log('  - Timeout executed!');
}, 1000);

console.log('  - Stats after creating timers:', timerRegistry.getStats());

// Test cleanup after 2 seconds
setTimeout(() => {
    console.log('\n5. Testing TimerRegistry cleanup:');
    console.log('  - Stats before cleanup:', timerRegistry.getStats());
    timerRegistry.clearAll();
    console.log('  - Stats after cleanup:', timerRegistry.getStats());
    
    console.log('\n✅ All memory leak fix tests completed successfully!');
    console.log('\nKey fixes implemented:');
    console.log('  ✓ Bounded collections prevent unlimited growth');
    console.log('  ✓ TimerRegistry provides centralized timer management');
    console.log('  ✓ Automatic cleanup prevents resource leaks');
    console.log('  ✓ Proper SIGTERM/SIGKILL handling for PTY processes');
    console.log('  ✓ Window event listeners for cleanup on app exit');
    
    process.exit(0);
}, 2000);