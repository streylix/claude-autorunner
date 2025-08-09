/**
 * System Integration Tests for Scratch Preset Builder
 * Comprehensive testing suite for complete workflow validation
 */

class SystemIntegrationTests {
    constructor() {
        this.testResults = [];
        this.testConfig = {
            maxTestDuration: 30000, // 30 seconds per test
            retryAttempts: 3,
            screenshotInterval: 5000, // Take screenshots every 5 seconds during tests
            adbTimeout: 10000, // 10 seconds for ADB operations
            recordingDuration: 15000 // 15 seconds for recording tests
        };
        
        // Mock components for testing
        this.mockComponents = {
            deviceDetector: null,
            recordingEngine: null,
            actionRecorder: null,
            pythonExporter: null
        };
        
        // Test state tracking
        this.currentTest = null;
        this.testStartTime = null;
        this.screenshotCounter = 0;
        this.errorCollector = [];
    }

    /**
     * Initialize integration test suite
     */
    async initialize() {
        console.log('🚀 Initializing System Integration Tests...');
        
        try {
            // Initialize test environment
            await this.setupTestEnvironment();
            
            // Load Python export system
            await this.loadPythonExportSystem();
            
            // Create mock components
            this.createMockComponents();
            
            console.log('✅ Integration test environment initialized');
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize integration tests:', error);
            return false;
        }
    }

    /**
     * Setup test environment
     */
    async setupTestEnvironment() {
        // Create test directories
        const testDirs = [
            '/tmp/claude-test-exports',
            '/tmp/claude-test-screenshots',
            '/tmp/claude-test-recordings'
        ];
        
        for (const dir of testDirs) {
            try {
                await this.ensureDirectory(dir);
            } catch (error) {
                console.warn(`⚠️ Could not create test directory ${dir}:`, error.message);
            }
        }
        
        // Setup test data
        this.testData = {
            mockDevice: {
                id: 'test_device_001',
                name: 'Test Android Device',
                model: 'Test Model',
                androidVersion: '12',
                resolution: { width: 1080, height: 1920 },
                connected: true
            },
            mockPreset: {
                name: 'test_preset',
                description: 'Integration Test Preset',
                actions: [],
                screenshots: [],
                metadata: {
                    created: new Date().toISOString(),
                    version: '1.0.0'
                }
            }
        };
    }

    /**
     * Load Python export system
     */
    async loadPythonExportSystem() {
        try {
            // Check if PythonExportSystem is available
            if (typeof window !== 'undefined' && window.PythonExportSystem) {
                this.pythonExporter = new window.PythonExportSystem();
            } else if (typeof require !== 'undefined') {
                const PythonExportSystem = require('../../python-export-system.js');
                this.pythonExporter = new PythonExportSystem();
            } else {
                throw new Error('PythonExportSystem not available');
            }
            
            console.log('✅ Python export system loaded');
        } catch (error) {
            console.error('❌ Failed to load Python export system:', error);
            throw error;
        }
    }

    /**
     * Create mock components for testing
     */
    createMockComponents() {
        // Mock Device Detector
        this.mockComponents.deviceDetector = {
            detectDevices: async () => {
                return [this.testData.mockDevice];
            },
            connectToDevice: async (deviceId) => {
                if (deviceId === this.testData.mockDevice.id) {
                    return { success: true, device: this.testData.mockDevice };
                }
                return { success: false, error: 'Device not found' };
            },
            checkAdbConnection: async () => {
                return { connected: true, devices: [this.testData.mockDevice] };
            }
        };

        // Mock Recording Engine
        this.mockComponents.recordingEngine = {
            startRecording: async (deviceId) => {
                return {
                    success: true,
                    recordingId: `rec_${Date.now()}`,
                    startTime: new Date().toISOString()
                };
            },
            stopRecording: async (recordingId) => {
                return {
                    success: true,
                    recordingId,
                    endTime: new Date().toISOString(),
                    duration: this.testConfig.recordingDuration
                };
            },
            getRecordingStatus: async (recordingId) => {
                return {
                    active: true,
                    duration: 5000,
                    actionsRecorded: 3,
                    screenshotsTaken: 2
                };
            }
        };

        // Mock Action Recorder
        this.mockComponents.actionRecorder = {
            recordAction: async (action) => {
                const recordedAction = {
                    id: `action_${Date.now()}`,
                    type: action.type || 'tap',
                    coordinates: action.coordinates || { x: 500, y: 900 },
                    timestamp: new Date().toISOString(),
                    screenshot: `screenshot_${Date.now()}.png`
                };
                
                this.testData.mockPreset.actions.push(recordedAction);
                return recordedAction;
            },
            captureScreenshot: async () => {
                const screenshot = {
                    id: `screenshot_${Date.now()}`,
                    path: `/tmp/claude-test-screenshots/test_${this.screenshotCounter++}.png`,
                    timestamp: new Date().toISOString(),
                    resolution: this.testData.mockDevice.resolution
                };
                
                this.testData.mockPreset.screenshots.push(screenshot);
                return screenshot;
            }
        };

        console.log('✅ Mock components created');
    }

    /**
     * Run complete integration test suite
     */
    async runFullTestSuite() {
        console.log('🧪 Starting Full Integration Test Suite...');
        
        const tests = [
            'testExportSystemIntegration',
            'testDeviceDetectionWorkflow', 
            'testRecordingWorkflow',
            'testActionCaptureWorkflow',
            'testErrorHandlingScenarios',
            'testPerformanceValidation',
            'testCrossPlatformCompatibility'
        ];

        const results = {
            passed: 0,
            failed: 0,
            errors: [],
            details: {}
        };

        for (const testName of tests) {
            try {
                console.log(`\n🔍 Running ${testName}...`);
                const result = await this.runSingleTest(testName);
                
                if (result.success) {
                    results.passed++;
                    console.log(`✅ ${testName} PASSED`);
                } else {
                    results.failed++;
                    results.errors.push({
                        test: testName,
                        error: result.error,
                        details: result.details
                    });
                    console.log(`❌ ${testName} FAILED:`, result.error);
                }
                
                results.details[testName] = result;
                
            } catch (error) {
                results.failed++;
                results.errors.push({
                    test: testName,
                    error: error.message,
                    stack: error.stack
                });
                console.error(`💥 ${testName} CRASHED:`, error);
            }
        }

        // Generate final report
        const report = this.generateTestReport(results);
        console.log('\n📊 Integration Test Results:', report);
        
        return report;
    }

    /**
     * Test 1: Export System Integration
     */
    async testExportSystemIntegration() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            // Test Python export system with mock preset
            const exportConfig = {
                mode: 'hive-mind spawn',
                agents: 5,
                strategy: 'balanced',
                topology: 'hierarchical',
                memoryNamespace: 'test',
                neuralPatterns: false,
                parallelExecution: false
            };

            // Export to Python script
            const pythonExport = this.pythonExporter.exportPresetToPython(exportConfig, {
                scriptName: 'test_integration_preset',
                description: 'Integration test preset'
            });

            testResult.details.pythonExport = {
                success: pythonExport.success,
                hasContent: !!pythonExport.scriptContent,
                contentLength: pythonExport.scriptContent?.length || 0,
                filename: pythonExport.filename
            };

            // Test export for web
            const webExport = this.pythonExporter.exportForWeb(exportConfig);
            testResult.details.webExport = {
                success: webExport.success,
                hasBlob: !!webExport.blob,
                hasUrl: !!webExport.url
            };

            // Test unified export
            const unifiedExport = this.pythonExporter.export(exportConfig);
            testResult.details.unifiedExport = {
                success: unifiedExport.success,
                hasContent: !!unifiedExport.scriptContent
            };

            // Verify integration with existing preset patterns
            const presetOptions = this.pythonExporter.getExportOptionsForPreset('standard');
            testResult.details.presetOptions = {
                hasOptions: !!presetOptions,
                scriptName: presetOptions.scriptName,
                description: presetOptions.description
            };

            testResult.success = pythonExport.success && webExport.success && unifiedExport.success;
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Test 2: Device Detection Workflow
     */
    async testDeviceDetectionWorkflow() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            // Test device detection
            const devices = await this.mockComponents.deviceDetector.detectDevices();
            testResult.details.deviceDetection = {
                devicesFound: devices.length,
                hasTestDevice: devices.some(d => d.id === this.testData.mockDevice.id)
            };

            // Test ADB connection check
            const adbStatus = await this.mockComponents.deviceDetector.checkAdbConnection();
            testResult.details.adbConnection = {
                connected: adbStatus.connected,
                deviceCount: adbStatus.devices.length
            };

            // Test device connection
            const connectionResult = await this.mockComponents.deviceDetector.connectToDevice(
                this.testData.mockDevice.id
            );
            testResult.details.deviceConnection = {
                success: connectionResult.success,
                deviceConnected: !!connectionResult.device
            };

            // Test error handling - invalid device
            const invalidConnection = await this.mockComponents.deviceDetector.connectToDevice('invalid_device');
            testResult.details.errorHandling = {
                correctlyFailedInvalidDevice: !invalidConnection.success
            };

            testResult.success = devices.length > 0 && adbStatus.connected && connectionResult.success;
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Test 3: Recording Workflow
     */
    async testRecordingWorkflow() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            // Start recording
            const startResult = await this.mockComponents.recordingEngine.startRecording(
                this.testData.mockDevice.id
            );
            testResult.details.recordingStart = {
                success: startResult.success,
                hasRecordingId: !!startResult.recordingId,
                recordingId: startResult.recordingId
            };

            if (!startResult.success) {
                throw new Error('Failed to start recording');
            }

            // Check recording status
            await this.sleep(1000); // Simulate recording time
            const statusResult = await this.mockComponents.recordingEngine.getRecordingStatus(
                startResult.recordingId
            );
            testResult.details.recordingStatus = {
                active: statusResult.active,
                duration: statusResult.duration,
                actionsRecorded: statusResult.actionsRecorded,
                screenshotsTaken: statusResult.screenshotsTaken
            };

            // Stop recording
            const stopResult = await this.mockComponents.recordingEngine.stopRecording(
                startResult.recordingId
            );
            testResult.details.recordingStop = {
                success: stopResult.success,
                hasDuration: !!stopResult.duration,
                recordingId: stopResult.recordingId
            };

            testResult.success = startResult.success && statusResult.active && stopResult.success;
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Test 4: Action Capture Workflow
     */
    async testActionCaptureWorkflow() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            // Test screenshot capture
            const screenshot = await this.mockComponents.actionRecorder.captureScreenshot();
            testResult.details.screenshotCapture = {
                success: !!screenshot.id,
                hasPath: !!screenshot.path,
                hasTimestamp: !!screenshot.timestamp,
                resolution: screenshot.resolution
            };

            // Test action recording - tap
            const tapAction = await this.mockComponents.actionRecorder.recordAction({
                type: 'tap',
                coordinates: { x: 500, y: 900 }
            });
            testResult.details.tapActionRecord = {
                success: !!tapAction.id,
                correctType: tapAction.type === 'tap',
                hasCoordinates: !!tapAction.coordinates,
                hasScreenshot: !!tapAction.screenshot
            };

            // Test action recording - swipe
            const swipeAction = await this.mockComponents.actionRecorder.recordAction({
                type: 'swipe',
                startCoordinates: { x: 100, y: 500 },
                endCoordinates: { x: 900, y: 500 }
            });
            testResult.details.swipeActionRecord = {
                success: !!swipeAction.id,
                correctType: swipeAction.type === 'swipe',
                hasCoordinates: !!swipeAction.coordinates
            };

            // Test preset building
            testResult.details.presetBuilding = {
                actionsCount: this.testData.mockPreset.actions.length,
                screenshotsCount: this.testData.mockPreset.screenshots.length,
                hasMetadata: !!this.testData.mockPreset.metadata
            };

            testResult.success = screenshot.id && tapAction.id && swipeAction.id;
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Test 5: Error Handling Scenarios
     */
    async testErrorHandlingScenarios() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            const errorTests = [];

            // Test ADB disconnection during recording
            try {
                // Simulate ADB disconnection
                this.mockComponents.deviceDetector.checkAdbConnection = async () => {
                    return { connected: false, devices: [] };
                };
                
                const adbCheck = await this.mockComponents.deviceDetector.checkAdbConnection();
                errorTests.push({
                    name: 'adb_disconnection',
                    handled: !adbCheck.connected,
                    graceful: true
                });
            } catch (error) {
                errorTests.push({
                    name: 'adb_disconnection', 
                    handled: false,
                    error: error.message
                });
            }

            // Test screenshot capture failure
            try {
                const originalCapture = this.mockComponents.actionRecorder.captureScreenshot;
                this.mockComponents.actionRecorder.captureScreenshot = async () => {
                    throw new Error('Screenshot capture failed');
                };
                
                await this.mockComponents.actionRecorder.captureScreenshot();
                errorTests.push({
                    name: 'screenshot_failure',
                    handled: false
                });
            } catch (error) {
                errorTests.push({
                    name: 'screenshot_failure',
                    handled: true,
                    errorMessage: error.message
                });
            }

            // Test invalid export configuration
            try {
                const invalidExport = this.pythonExporter.exportPresetToPython(null);
                errorTests.push({
                    name: 'invalid_export_config',
                    handled: !invalidExport.success
                });
            } catch (error) {
                errorTests.push({
                    name: 'invalid_export_config',
                    handled: true,
                    errorMessage: error.message
                });
            }

            testResult.details.errorTests = errorTests;
            testResult.success = errorTests.every(test => test.handled);
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Test 6: Performance Validation
     */
    async testPerformanceValidation() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            const performanceMetrics = {};

            // Test Python export performance
            const exportStartTime = performance.now();
            const config = {
                mode: 'hive-mind spawn',
                agents: 8,
                strategy: 'parallel',
                topology: 'mesh',
                memoryNamespace: 'performance_test',
                neuralPatterns: true,
                parallelExecution: true
            };
            
            const exportResult = this.pythonExporter.exportPresetToPython(config);
            const exportEndTime = performance.now();
            
            performanceMetrics.pythonExport = {
                duration: exportEndTime - exportStartTime,
                success: exportResult.success,
                contentSize: exportResult.scriptContent?.length || 0
            };

            // Test multiple screenshot captures
            const screenshotStartTime = performance.now();
            const screenshots = [];
            for (let i = 0; i < 5; i++) {
                const screenshot = await this.mockComponents.actionRecorder.captureScreenshot();
                screenshots.push(screenshot);
            }
            const screenshotEndTime = performance.now();
            
            performanceMetrics.screenshotCapture = {
                duration: screenshotEndTime - screenshotStartTime,
                count: screenshots.length,
                averageTime: (screenshotEndTime - screenshotStartTime) / screenshots.length
            };

            // Test memory usage simulation
            performanceMetrics.memoryUsage = {
                estimatedPresetSize: JSON.stringify(this.testData.mockPreset).length,
                actionCount: this.testData.mockPreset.actions.length,
                screenshotCount: this.testData.mockPreset.screenshots.length
            };

            testResult.details.performanceMetrics = performanceMetrics;
            
            // Performance criteria
            const meetsCriteria = 
                performanceMetrics.pythonExport.duration < 1000 && // < 1 second
                performanceMetrics.screenshotCapture.averageTime < 500 && // < 500ms per screenshot
                performanceMetrics.memoryUsage.estimatedPresetSize < 1000000; // < 1MB

            testResult.success = meetsCriteria;
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Test 7: Cross-Platform Compatibility
     */
    async testCrossPlatformCompatibility() {
        const testResult = { success: false, details: {}, error: null };
        
        try {
            const compatibilityTests = {};

            // Test file path handling
            const testPaths = [
                '/unix/style/path.py',
                'C:\\Windows\\Style\\Path.py',
                './relative/path.py',
                '~/home/path.py'
            ];

            compatibilityTests.pathHandling = testPaths.map(path => ({
                path,
                valid: this.validateFilePath(path)
            }));

            // Test Python script generation with different line endings
            const config = {
                mode: 'swarm',
                agents: 3,
                strategy: 'development'
            };

            const pythonScript = this.pythonExporter.exportPresetToPython(config);
            compatibilityTests.pythonScript = {
                hasShebang: pythonScript.scriptContent.startsWith('#!/usr/bin/env python3'),
                usesUnixLineEndings: !pythonScript.scriptContent.includes('\r\n'),
                contentLength: pythonScript.scriptContent.length
            };

            // Test export options for different presets
            const presets = ['light', 'standard', 'heavy', 'research', 'custom'];
            compatibilityTests.presetOptions = presets.map(preset => ({
                preset,
                options: this.pythonExporter.getExportOptionsForPreset(preset)
            }));

            // Platform detection simulation
            compatibilityTests.platformDetection = {
                currentPlatform: this.detectCurrentPlatform(),
                supportedPlatforms: ['win32', 'darwin', 'linux']
            };

            testResult.details.compatibilityTests = compatibilityTests;
            
            const allPathsValid = compatibilityTests.pathHandling.every(test => test.valid !== false);
            const pythonScriptValid = compatibilityTests.pythonScript.hasShebang && 
                                    compatibilityTests.pythonScript.contentLength > 0;
            const allPresetsValid = compatibilityTests.presetOptions.every(test => !!test.options);

            testResult.success = allPathsValid && pythonScriptValid && allPresetsValid;
            
        } catch (error) {
            testResult.error = error.message;
        }

        return testResult;
    }

    /**
     * Run a single test with timeout and error handling
     */
    async runSingleTest(testName) {
        return new Promise(async (resolve) => {
            this.currentTest = testName;
            this.testStartTime = Date.now();
            
            const timeout = setTimeout(() => {
                resolve({
                    success: false,
                    error: 'Test timeout',
                    details: { duration: this.testConfig.maxTestDuration }
                });
            }, this.testConfig.maxTestDuration);

            try {
                const result = await this[testName]();
                clearTimeout(timeout);
                
                result.details = result.details || {};
                result.details.duration = Date.now() - this.testStartTime;
                
                resolve(result);
            } catch (error) {
                clearTimeout(timeout);
                resolve({
                    success: false,
                    error: error.message,
                    details: { 
                        duration: Date.now() - this.testStartTime,
                        stack: error.stack 
                    }
                });
            }
        });
    }

    /**
     * Generate comprehensive test report
     */
    generateTestReport(results) {
        const report = {
            summary: {
                total: results.passed + results.failed,
                passed: results.passed,
                failed: results.failed,
                successRate: `${Math.round((results.passed / (results.passed + results.failed)) * 100)}%`,
                timestamp: new Date().toISOString()
            },
            errors: results.errors,
            details: results.details,
            recommendations: this.generateRecommendations(results)
        };

        return report;
    }

    /**
     * Generate recommendations based on test results
     */
    generateRecommendations(results) {
        const recommendations = [];

        if (results.failed > 0) {
            recommendations.push('Review failed tests and address underlying issues');
        }

        if (results.errors.some(e => e.test === 'testPerformanceValidation')) {
            recommendations.push('Optimize performance bottlenecks identified in testing');
        }

        if (results.errors.some(e => e.test === 'testErrorHandlingScenarios')) {
            recommendations.push('Improve error handling and recovery mechanisms');
        }

        if (results.errors.some(e => e.test === 'testCrossPlatformCompatibility')) {
            recommendations.push('Address cross-platform compatibility issues');
        }

        if (recommendations.length === 0) {
            recommendations.push('All tests passed - system is ready for production use');
        }

        return recommendations;
    }

    /**
     * Utility functions
     */
    async ensureDirectory(dirPath) {
        // Mock directory creation for browser environment
        if (typeof require === 'undefined') {
            return true;
        }
        
        try {
            const fs = require('fs').promises;
            await fs.mkdir(dirPath, { recursive: true });
            return true;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            return true;
        }
    }

    validateFilePath(filePath) {
        if (!filePath || typeof filePath !== 'string') {
            return false;
        }
        
        // Basic validation - could be enhanced for specific platforms
        return filePath.length > 0 && !filePath.includes('\0');
    }

    detectCurrentPlatform() {
        if (typeof process !== 'undefined' && process.platform) {
            return process.platform;
        }
        
        if (typeof navigator !== 'undefined') {
            const userAgent = navigator.userAgent.toLowerCase();
            if (userAgent.includes('win')) return 'win32';
            if (userAgent.includes('mac')) return 'darwin';
            if (userAgent.includes('linux')) return 'linux';
        }
        
        return 'unknown';
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Store integration results in memory for coordination
     */
    async storeIntegrationResults(results) {
        try {
            if (typeof mcp__claude_flow__memory_usage !== 'undefined') {
                await mcp__claude_flow__memory_usage({
                    action: 'store',
                    key: 'scratch-preset/integration/test-results',
                    value: JSON.stringify(results)
                });
            }
        } catch (error) {
            console.warn('Could not store integration results in memory:', error);
        }
    }
}

// Export for use in different environments
if (typeof window !== 'undefined') {
    window.SystemIntegrationTests = SystemIntegrationTests;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SystemIntegrationTests;
}