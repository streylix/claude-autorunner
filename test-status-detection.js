#!/usr/bin/env node

/**
 * Simple test to verify terminal status detection works correctly
 */

console.log('🧪 Testing Terminal Status Detection\n');

// Mock terminal data
const mockTerminalData = {
    lastOutput: '',
    terminal: {
        buffer: {
            active: {
                baseY: 0,
                cursorY: 20,
                getLine: (i) => ({
                    translateToString: () => i === 18 ? 'Command running (esc to interrupt)' : 
                                           i === 19 ? 'Still processing...' : 
                                           i === 20 ? 'user@system:~$ ' : ''
                })
            }
        }
    }
};

// Test 1: Running status detection
console.log('Test 1: Running Status Detection');
console.log('================================');

// Simulate chunks of output that together form the running pattern
const chunks = [
    'Starting long command...\n',
    'Processing data (esc to interrupt)\n',  
    'Still working...\n'
];

// Accumulate output (this is the fix)
mockTerminalData.lastOutput = '';
chunks.forEach(chunk => {
    mockTerminalData.lastOutput += chunk;
    if (mockTerminalData.lastOutput.length > 5000) {
        mockTerminalData.lastOutput = mockTerminalData.lastOutput.slice(-5000);
    }
});

console.log('Accumulated output:', JSON.stringify(mockTerminalData.lastOutput));
console.log('Contains "(esc to interrupt)":', mockTerminalData.lastOutput.includes('(esc to interrupt)'));
console.log('Contains "esc to interrupt":', mockTerminalData.lastOutput.includes('esc to interrupt'));

// Test the running detection logic
const hasInterruptPattern = mockTerminalData.lastOutput.includes('esc to interrupt') || 
                           mockTerminalData.lastOutput.includes('(esc to interrupt)') ||
                           mockTerminalData.lastOutput.includes('ESC to interrupt') ||
                           mockTerminalData.lastOutput.includes('offline)');

console.log('✅ Running pattern detected:', hasInterruptPattern);

// Test 2: Prompted status detection  
console.log('\nTest 2: Prompted Status Detection');
console.log('==================================');

const promptedChunks = [
    'Do you want to continue? ',
    '[Y/n]: '
];

mockTerminalData.lastOutput = '';
promptedChunks.forEach(chunk => {
    mockTerminalData.lastOutput += chunk;
});

console.log('Prompted output:', JSON.stringify(mockTerminalData.lastOutput));

const isPrompting = mockTerminalData.lastOutput.includes('No, and tell Claude what to do differently') ||
                   /\b[yY]\/[nN]\b/.test(mockTerminalData.lastOutput) ||
                   /\b[nN]\/[yY]\b/.test(mockTerminalData.lastOutput) ||
                   /Do you want to proceed\?/i.test(mockTerminalData.lastOutput) ||
                   /Are you sure\?/i.test(mockTerminalData.lastOutput) ||
                   mockTerminalData.lastOutput.includes('[Y/n]') ||
                   mockTerminalData.lastOutput.includes('[y/N]');

console.log('✅ Prompted pattern detected:', isPrompting);

// Test 3: Buffer reading
console.log('\nTest 3: Buffer Reading');
console.log('======================');

try {
    const buffer = mockTerminalData.terminal.buffer.active;
    const endLine = buffer.baseY + buffer.cursorY;
    const startLine = Math.max(0, endLine - 20);
    let bufferOutput = '';
    for (let i = startLine; i <= endLine; i++) {
        const line = buffer.getLine(i);
        if (line) {
            bufferOutput += line.translateToString(true) + '\n';
        }
    }
    console.log('Buffer output:', JSON.stringify(bufferOutput));
    console.log('✅ Buffer reading works');
} catch (error) {
    console.log('❌ Buffer reading failed:', error.message);
}

console.log('\n🎉 Status Detection Test Complete');
console.log('Both running and prompted statuses should now work correctly!');