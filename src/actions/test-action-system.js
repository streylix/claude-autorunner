/**
 * Action Recording System Test Suite
 * Comprehensive testing for coordinate mapping precision and user interaction
 */

const { ActionRecordingSystem } = require('./index.js');

class ActionSystemTester {
    constructor() {
        this.testResults = [];
        this.totalTests = 0;
        this.passedTests = 0;
        this.failedTests = 0;
        
        this.mockDeviceInfo = {
            displayWidth: 1080,
            displayHeight: 1920,
            density: 420
        };
    }
    
    /**
     * Run all tests
     */
    async runAllTests() {
        console.log('🧪 Starting Action Recording System Tests...\n');
        
        try {
            // Test coordinate mapping precision
            await this.testCoordinateMappingPrecision();
            
            // Test visual feedback system
            await this.testVisualFeedbackSystem();
            
            // Test action recording accuracy
            await this.testActionRecordingAccuracy();
            
            // Test sequence management
            await this.testSequenceManagement();
            
            // Test export functionality
            await this.testExportFunctionality();
            
            // Test integration components
            await this.testIntegrationComponents();
            
            // Print summary
            this.printTestSummary();
            
            return this.generateTestReport();
            
        } catch (error) {
            console.error('❌ Test suite failed:', error);
            return {
                success: false,
                error: error.message,
                results: this.testResults
            };
        }
    }
    
    /**
     * Test coordinate mapping precision
     */
    async testCoordinateMappingPrecision() {
        console.log('📐 Testing Coordinate Mapping Precision...');
        
        const { CoordinateMapper } = require('./index.js');
        
        // Test 1: Basic initialization
        await this.runTest('Coordinate Mapper Initialization', async () => {
            const mapper = new CoordinateMapper();
            
            // Create mock UI element
            const mockElement = {
                getBoundingClientRect: () => ({
                    width: 300,
                    height: 600,
                    left: 50,
                    top: 100
                })
            };
            
            const success = mapper.initialize(mockElement, this.mockDeviceInfo);
            this.assert(success, 'Mapper should initialize successfully');
            
            const stats = mapper.getStatistics();
            this.assert(stats.isInitialized, 'Mapper should be initialized');
            this.assert(stats.hasValidMapping, 'Mapper should have valid mapping');
        });
        
        // Test 2: Coordinate transformation accuracy
        await this.runTest('Coordinate Transformation Accuracy', async () => {
            const mapper = new CoordinateMapper();
            
            const mockElement = {
                getBoundingClientRect: () => ({
                    width: 270, // 1080 / 4 for 4:1 scaling
                    height: 480, // 1920 / 4 for 4:1 scaling
                    left: 0,
                    top: 0
                })
            };
            
            mapper.initialize(mockElement, this.mockDeviceInfo);
            
            // Test center point mapping
            const centerUI = { x: 135, y: 240 };
            const centerDevice = mapper.uiToDevice(centerUI.x, centerUI.y);
            
            this.assert(
                Math.abs(centerDevice.x - 540) < 1,
                `Center X should map to ~540, got ${centerDevice.x}`
            );
            this.assert(
                Math.abs(centerDevice.y - 960) < 1,
                `Center Y should map to ~960, got ${centerDevice.y}`
            );
            
            // Test round-trip accuracy
            const backToUI = mapper.deviceToUI(centerDevice.x, centerDevice.y);
            const errorX = Math.abs(backToUI.x - centerUI.x);
            const errorY = Math.abs(backToUI.y - centerUI.y);
            
            this.assert(errorX < 1, `Round-trip X error should be < 1px, got ${errorX}`);
            this.assert(errorY < 1, `Round-trip Y error should be < 1px, got ${errorY}`);
        });
        
        // Test 3: Edge case handling
        await this.runTest('Edge Case Handling', async () => {
            const mapper = new CoordinateMapper({
                validateBounds: true,
                allowOutOfBounds: false
            });
            
            const mockElement = {
                getBoundingClientRect: () => ({
                    width: 270,
                    height: 480,
                    left: 0,
                    top: 0
                })
            };
            
            mapper.initialize(mockElement, this.mockDeviceInfo);
            
            // Test out-of-bounds handling
            try {
                mapper.uiToDevice(-10, -10);
                this.assert(false, 'Should throw error for out-of-bounds coordinates');
            } catch (error) {
                this.assert(
                    error.message.includes('out of bounds'),
                    'Should throw out-of-bounds error'
                );
            }
        });
        
        // Test 4: Precision validation
        await this.runTest('Precision Validation', async () => {
            const mapper = new CoordinateMapper({
                coordinatePrecision: 2,
                scaleFactorPrecision: 4
            });
            
            const mockElement = {
                getBoundingClientRect: () => ({
                    width: 270,
                    height: 480,
                    left: 0,
                    top: 0
                })
            };
            
            mapper.initialize(mockElement, this.mockDeviceInfo);
            
            const result = mapper.uiToDevice(123.456789, 234.567890);
            
            // Check precision
            const xDecimalPlaces = (result.x.toString().split('.')[1] || '').length;
            const yDecimalPlaces = (result.y.toString().split('.')[1] || '').length;
            
            this.assert(
                xDecimalPlaces <= 2,
                `X precision should be <= 2 decimal places, got ${xDecimalPlaces}`
            );
            this.assert(
                yDecimalPlaces <= 2,
                `Y precision should be <= 2 decimal places, got ${yDecimalPlaces}`
            );
        });
        
        console.log('✅ Coordinate mapping precision tests completed\n');
    }
    
    /**
     * Test visual feedback system
     */
    async testVisualFeedbackSystem() {
        console.log('🎨 Testing Visual Feedback System...');
        
        const { VisualFeedback } = require('./index.js');
        
        // Test 1: Initialization
        await this.runTest('Visual Feedback Initialization', async () => {
            const feedback = new VisualFeedback();
            
            // Create mock container
            const mockContainer = document.createElement('div');
            document.body.appendChild(mockContainer);
            
            const success = feedback.initialize(mockContainer);
            this.assert(success, 'Visual feedback should initialize successfully');
            
            document.body.removeChild(mockContainer);
        });
        
        // Test 2: Feedback rendering
        await this.runTest('Feedback Rendering', async () => {
            const feedback = new VisualFeedback({
                animationDuration: 100 // Short duration for testing
            });
            
            feedback.initialize(document.body);
            
            // Test click feedback
            const clickId = feedback.showClickFeedback(100, 100);
            this.assert(clickId, 'Should return feedback ID for click');
            
            // Test drag feedback
            const dragId = feedback.showDragFeedback(50, 50, 150, 150);
            this.assert(dragId, 'Should return feedback ID for drag');
            
            // Test active feedback count
            const activeCount = feedback.getActiveFeedbackCount();
            this.assert(activeCount >= 2, `Should have at least 2 active feedbacks, got ${activeCount}`);
            
            // Wait for animations to complete
            await this.sleep(200);
            
            feedback.cleanup();
        });
        
        console.log('✅ Visual feedback system tests completed\n');
    }
    
    /**
     * Test action recording accuracy
     */
    async testActionRecordingAccuracy() {
        console.log('🎯 Testing Action Recording Accuracy...');
        
        const { ActionRecorder, CoordinateMapper } = require('./index.js');
        
        // Test 1: Basic recording
        await this.runTest('Basic Action Recording', async () => {
            const recorder = new ActionRecorder();
            const mapper = new CoordinateMapper();
            
            // Initialize components
            const mockElement = {
                getBoundingClientRect: () => ({
                    width: 270,
                    height: 480,
                    left: 0,
                    top: 0
                })
            };
            
            mapper.initialize(mockElement, this.mockDeviceInfo);
            recorder.initialize(mapper, this.mockDeviceInfo);
            
            // Start recording
            const sequenceId = recorder.startRecording('Test Sequence');
            this.assert(sequenceId, 'Should return sequence ID');
            
            // Record some actions
            const clickAction = recorder.recordClick(100, 200);
            this.assert(clickAction, 'Should record click action');
            this.assert(clickAction.type === 'click', 'Action type should be click');
            
            const dragAction = recorder.recordDrag(50, 50, 150, 150);
            this.assert(dragAction, 'Should record drag action');
            this.assert(dragAction.type === 'drag', 'Action type should be drag');
            
            // Stop recording
            const sequence = recorder.stopRecording();
            this.assert(sequence, 'Should return completed sequence');
            this.assert(sequence.actions.length === 2, 'Should have 2 recorded actions');
            
            recorder.cleanup();
        });
        
        // Test 2: Coordinate accuracy
        await this.runTest('Action Coordinate Accuracy', async () => {
            const recorder = new ActionRecorder();
            const mapper = new CoordinateMapper();
            
            const mockElement = {
                getBoundingClientRect: () => ({
                    width: 270,
                    height: 480,
                    left: 0,
                    top: 0
                })
            };
            
            mapper.initialize(mockElement, this.mockDeviceInfo);
            recorder.initialize(mapper, this.mockDeviceInfo);
            
            recorder.startRecording('Coordinate Test');
            
            // Record action at known coordinates
            const testX = 135; // Center X
            const testY = 240; // Center Y
            const action = recorder.recordClick(testX, testY);
            
            // Verify UI coordinates
            this.assert(
                action.uiCoordinates.clientX === testX,
                `UI X should be ${testX}, got ${action.uiCoordinates.clientX}`
            );
            this.assert(
                action.uiCoordinates.clientY === testY,
                `UI Y should be ${testY}, got ${action.uiCoordinates.clientY}`
            );
            
            // Verify device coordinates mapping
            this.assert(
                action.deviceCoordinates.x,
                'Should have device X coordinate'
            );
            this.assert(
                action.deviceCoordinates.y,
                'Should have device Y coordinate'
            );
            
            // Verify expected device coordinates (4:1 scaling)
            const expectedDeviceX = 540; // testX * 4
            const expectedDeviceY = 960; // testY * 4
            
            this.assert(
                Math.abs(action.deviceCoordinates.x - expectedDeviceX) < 1,
                `Device X should be ~${expectedDeviceX}, got ${action.deviceCoordinates.x}`
            );
            this.assert(
                Math.abs(action.deviceCoordinates.y - expectedDeviceY) < 1,
                `Device Y should be ~${expectedDeviceY}, got ${action.deviceCoordinates.y}`
            );
            
            recorder.cleanup();
        });
        
        console.log('✅ Action recording accuracy tests completed\n');
    }
    
    /**
     * Test sequence management
     */
    async testSequenceManagement() {
        console.log('📋 Testing Sequence Management...');
        
        const { ActionRecorder } = require('./index.js');
        
        // Test 1: Multiple sequences
        await this.runTest('Multiple Sequence Management', async () => {
            const recorder = new ActionRecorder();
            recorder.initialize({}, this.mockDeviceInfo);
            
            // Create first sequence
            const seq1Id = recorder.startRecording('Sequence 1');
            recorder.recordClick(100, 100);
            const sequence1 = recorder.stopRecording();
            
            // Create second sequence
            const seq2Id = recorder.startRecording('Sequence 2');
            recorder.recordClick(200, 200);
            recorder.recordDrag(50, 50, 250, 250);
            const sequence2 = recorder.stopRecording();
            
            // Verify sequences
            const allSequences = recorder.getAllSequences();
            this.assert(allSequences.length === 2, 'Should have 2 sequences');
            
            // Verify sequence content
            this.assert(sequence1.actions.length === 1, 'Sequence 1 should have 1 action');
            this.assert(sequence2.actions.length === 2, 'Sequence 2 should have 2 actions');
            
            // Test sequence retrieval
            const retrievedSeq1 = recorder.getSequence(seq1Id);
            this.assert(retrievedSeq1, 'Should retrieve sequence 1');
            this.assert(retrievedSeq1.name === 'Sequence 1', 'Should have correct name');
            
            recorder.cleanup();
        });
        
        // Test 2: Sequence editing
        await this.runTest('Sequence Editing', async () => {
            const recorder = new ActionRecorder();
            recorder.initialize({}, this.mockDeviceInfo);
            
            const sequenceId = recorder.startRecording('Editable Sequence');
            recorder.recordClick(100, 100);
            const sequence = recorder.stopRecording();
            
            // Test sequence editing
            const updatedSequence = recorder.editSequence(sequenceId, {
                name: 'Updated Sequence',
                description: 'Updated description'
            });
            
            this.assert(updatedSequence, 'Should return updated sequence');
            this.assert(updatedSequence.name === 'Updated Sequence', 'Should have updated name');
            this.assert(updatedSequence.lastModified, 'Should have lastModified timestamp');
            
            recorder.cleanup();
        });
        
        console.log('✅ Sequence management tests completed\n');
    }
    
    /**
     * Test export functionality
     */
    async testExportFunctionality() {
        console.log('📤 Testing Export Functionality...');
        
        const { ActionExportIntegration } = require('./index.js');
        
        // Test 1: JSON export
        await this.runTest('JSON Export', async () => {
            const exporter = new ActionExportIntegration();
            
            const mockSequence = {
                id: 'test_seq_1',
                name: 'Test Sequence',
                duration: 5000,
                actions: [
                    {
                        id: 'action_1',
                        type: 'click',
                        relativeTime: 0,
                        uiCoordinates: { clientX: 100, clientY: 200 },
                        deviceCoordinates: { x: 400, y: 800 },
                        metadata: {}
                    },
                    {
                        id: 'action_2',
                        type: 'drag',
                        relativeTime: 1000,
                        uiCoordinates: { clientX: 50, clientY: 50, endX: 150, endY: 150 },
                        deviceCoordinates: { x: 200, y: 200, endX: 600, endY: 600 },
                        metadata: { duration: 500 }
                    }
                ]
            };
            
            const result = exporter.exportForPreset([mockSequence], {
                name: 'Test Preset',
                description: 'Test export'
            });
            
            this.assert(result.success, 'Export should succeed');
            this.assert(result.data, 'Should have export data');
            this.assert(result.data.preset, 'Should have preset data');
            this.assert(result.data.actionSequences, 'Should have action sequences');
            this.assert(result.data.actionSequences.length === 1, 'Should have 1 sequence');
            this.assert(result.data.actionSequences[0].actions.length === 2, 'Should have 2 actions');
        });
        
        // Test 2: Python export
        await this.runTest('Python Export', async () => {
            const exporter = new ActionExportIntegration({
                exportFormat: 'python'
            });
            
            const mockSequence = {
                id: 'test_seq_python',
                name: 'Python Test Sequence',
                duration: 2000,
                actions: [
                    {
                        id: 'py_action_1',
                        type: 'click',
                        relativeTime: 0,
                        deviceCoordinates: { x: 540, y: 960 },
                        metadata: {}
                    }
                ]
            };
            
            const result = exporter.exportForPreset([mockSequence], {
                name: 'Python Test Preset'
            });
            
            this.assert(result.success, 'Python export should succeed');
            
            // Generate Python code
            const pythonResult = exporter.generatePythonExport(result.data);
            
            this.assert(pythonResult.content, 'Should generate Python content');
            this.assert(pythonResult.filename.endsWith('.py'), 'Should have .py extension');
            
            // Verify Python code contains expected elements
            this.assert(
                pythonResult.content.includes('class ActionSequence'),
                'Should contain ActionSequence class'
            );
            this.assert(
                pythonResult.content.includes('def execute_sequence'),
                'Should contain execute_sequence method'
            );
        });
        
        console.log('✅ Export functionality tests completed\n');
    }
    
    /**
     * Test integration components
     */
    async testIntegrationComponents() {
        console.log('🔗 Testing Integration Components...');
        
        // Test 1: System initialization
        await this.runTest('System Integration', async () => {
            const { ActionRecordingSystem } = require('./index.js');
            
            const system = new ActionRecordingSystem({
                enableVisualFeedback: false, // Disable for testing
                enableSequenceEditor: false  // Disable for testing
            });
            
            // Mock screenshot engine
            const mockScreenshotEngine = {
                on: () => {},
                capture: () => Promise.resolve({ success: true })
            };
            
            const success = await system.initialize(mockScreenshotEngine, this.mockDeviceInfo);
            this.assert(success, 'System should initialize successfully');
            
            const state = system.getRecordingState();
            this.assert(state.isInitialized, 'System should be initialized');
            this.assert(!state.isRecording, 'Should not be recording initially');
            
            // Test recording cycle
            system.startRecording('Integration Test');
            const recordingState = system.getRecordingState();
            this.assert(recordingState.isRecording, 'Should be recording');
            
            const sequence = system.stopRecording();
            this.assert(sequence, 'Should return sequence');
            
            const finalState = system.getRecordingState();
            this.assert(!finalState.isRecording, 'Should not be recording after stop');
            
            system.cleanup();
        });
        
        // Test 2: Statistics and monitoring
        await this.runTest('System Statistics', async () => {
            const { ActionRecordingSystem } = require('./index.js');
            
            const system = new ActionRecordingSystem();
            const mockScreenshotEngine = { on: () => {} };
            
            await system.initialize(mockScreenshotEngine, this.mockDeviceInfo);
            
            const stats = system.getSystemStatistics();
            
            this.assert(stats.isInitialized, 'Stats should show initialized');
            this.assert(stats.sequenceCount === 0, 'Should start with 0 sequences');
            this.assert(stats.totalActions === 0, 'Should start with 0 actions');
            this.assert(stats.componentStats, 'Should have component stats');
            
            system.cleanup();
        });
        
        console.log('✅ Integration component tests completed\n');
    }
    
    /**
     * Run individual test
     */
    async runTest(testName, testFunction) {
        this.totalTests++;
        
        try {
            await testFunction();
            this.passedTests++;
            this.testResults.push({
                name: testName,
                status: 'PASS',
                duration: 0 // Could add timing
            });
            console.log(`  ✅ ${testName}`);
        } catch (error) {
            this.failedTests++;
            this.testResults.push({
                name: testName,
                status: 'FAIL',
                error: error.message,
                duration: 0
            });
            console.log(`  ❌ ${testName}: ${error.message}`);
        }
    }
    
    /**
     * Assert helper
     */
    assert(condition, message) {
        if (!condition) {
            throw new Error(message || 'Assertion failed');
        }
    }
    
    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Print test summary
     */
    printTestSummary() {
        console.log('\n📊 Test Summary:');
        console.log(`Total Tests: ${this.totalTests}`);
        console.log(`Passed: ${this.passedTests} ✅`);
        console.log(`Failed: ${this.failedTests} ❌`);
        console.log(`Success Rate: ${((this.passedTests / this.totalTests) * 100).toFixed(1)}%`);
        
        if (this.failedTests > 0) {
            console.log('\n❌ Failed Tests:');
            this.testResults
                .filter(result => result.status === 'FAIL')
                .forEach(result => {
                    console.log(`  - ${result.name}: ${result.error}`);
                });
        }
    }
    
    /**
     * Generate test report
     */
    generateTestReport() {
        return {
            success: this.failedTests === 0,
            summary: {
                totalTests: this.totalTests,
                passedTests: this.passedTests,
                failedTests: this.failedTests,
                successRate: (this.passedTests / this.totalTests) * 100
            },
            results: this.testResults,
            timestamp: new Date().toISOString()
        };
    }
}

// Export tester
module.exports = ActionSystemTester;

// Run tests if called directly
if (require.main === module) {
    const tester = new ActionSystemTester();
    tester.runAllTests().then(report => {
        if (report.success) {
            console.log('\n🎉 All tests passed!');
            process.exit(0);
        } else {
            console.log('\n💥 Some tests failed!');
            process.exit(1);
        }
    });
}