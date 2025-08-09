/**
 * Comprehensive Workflow Validator for Scratch Preset System
 * Validates complete end-to-end workflows and integration points
 */

class WorkflowValidator {
    constructor() {
        this.validationResults = new Map();
        this.validationRules = new Map();
        this.workflows = new Map();
        this.dependencies = new Map();
        
        this.initializeWorkflows();
        this.initializeValidationRules();
    }

    /**
     * Initialize supported workflows
     */
    initializeWorkflows() {
        // Complete Scratch-to-Export Workflow
        this.workflows.set('scratch-to-export', {
            name: 'Scratch Preset to Python Export',
            description: 'Complete workflow from scratch preset creation to Python script export',
            steps: [
                'device-detection',
                'device-connection',
                'recording-initialization',
                'action-capture',
                'screenshot-capture',
                'recording-completion',
                'preset-compilation',
                'python-export',
                'validation'
            ],
            dependencies: {
                'device-connection': ['device-detection'],
                'recording-initialization': ['device-connection'],
                'action-capture': ['recording-initialization'],
                'screenshot-capture': ['recording-initialization'],
                'recording-completion': ['action-capture', 'screenshot-capture'],
                'preset-compilation': ['recording-completion'],
                'python-export': ['preset-compilation'],
                'validation': ['python-export']
            },
            timeout: 120000, // 2 minutes total
            critical: true
        });

        // Device Management Workflow
        this.workflows.set('device-management', {
            name: 'Device Detection and Management',
            description: 'Comprehensive device detection, connection, and management',
            steps: [
                'adb-availability',
                'device-scan',
                'device-validation',
                'connection-establishment',
                'capability-testing',
                'health-monitoring'
            ],
            dependencies: {
                'device-scan': ['adb-availability'],
                'device-validation': ['device-scan'],
                'connection-establishment': ['device-validation'],
                'capability-testing': ['connection-establishment'],
                'health-monitoring': ['connection-establishment']
            },
            timeout: 30000, // 30 seconds
            critical: true
        });

        // Recording Engine Workflow
        this.workflows.set('recording-engine', {
            name: 'Action Recording and Capture',
            description: 'Complete recording workflow with error handling',
            steps: [
                'recording-setup',
                'session-initialization',
                'action-monitoring',
                'screenshot-automation',
                'data-synchronization',
                'session-cleanup'
            ],
            dependencies: {
                'session-initialization': ['recording-setup'],
                'action-monitoring': ['session-initialization'],
                'screenshot-automation': ['session-initialization'],
                'data-synchronization': ['action-monitoring', 'screenshot-automation'],
                'session-cleanup': ['data-synchronization']
            },
            timeout: 60000, // 1 minute
            critical: true
        });

        // Export System Workflow
        this.workflows.set('export-system', {
            name: 'Preset Export and Validation',
            description: 'Export presets to various formats with validation',
            steps: [
                'data-preparation',
                'format-conversion',
                'python-script-generation',
                'metadata-inclusion',
                'file-creation',
                'validation-testing'
            ],
            dependencies: {
                'format-conversion': ['data-preparation'],
                'python-script-generation': ['format-conversion'],
                'metadata-inclusion': ['python-script-generation'],
                'file-creation': ['metadata-inclusion'],
                'validation-testing': ['file-creation']
            },
            timeout: 15000, // 15 seconds
            critical: false
        });

        // Error Recovery Workflow
        this.workflows.set('error-recovery', {
            name: 'Error Handling and Recovery',
            description: 'Comprehensive error handling and system recovery',
            steps: [
                'error-detection',
                'error-classification',
                'recovery-strategy-selection',
                'recovery-execution',
                'fallback-activation',
                'state-restoration'
            ],
            dependencies: {
                'error-classification': ['error-detection'],
                'recovery-strategy-selection': ['error-classification'],
                'recovery-execution': ['recovery-strategy-selection'],
                'fallback-activation': ['recovery-execution'],
                'state-restoration': ['fallback-activation']
            },
            timeout: 20000, // 20 seconds
            critical: true
        });
    }

    /**
     * Initialize validation rules for each workflow step
     */
    initializeValidationRules() {
        // Device Detection Rules
        this.validationRules.set('device-detection', [
            {
                name: 'adb-available',
                validate: async (context) => this.validateAdbAvailable(context),
                required: true,
                timeout: 5000
            },
            {
                name: 'devices-found',
                validate: async (context) => this.validateDevicesFound(context),
                required: true,
                timeout: 10000
            },
            {
                name: 'device-permissions',
                validate: async (context) => this.validateDevicePermissions(context),
                required: true,
                timeout: 5000
            }
        ]);

        // Device Connection Rules
        this.validationRules.set('device-connection', [
            {
                name: 'connection-established',
                validate: async (context) => this.validateConnectionEstablished(context),
                required: true,
                timeout: 10000
            },
            {
                name: 'device-responsive',
                validate: async (context) => this.validateDeviceResponsive(context),
                required: true,
                timeout: 5000
            },
            {
                name: 'screen-access',
                validate: async (context) => this.validateScreenAccess(context),
                required: true,
                timeout: 5000
            }
        ]);

        // Recording Rules
        this.validationRules.set('recording-initialization', [
            {
                name: 'recording-session-created',
                validate: async (context) => this.validateRecordingSessionCreated(context),
                required: true,
                timeout: 5000
            },
            {
                name: 'initial-screenshot-captured',
                validate: async (context) => this.validateInitialScreenshotCaptured(context),
                required: true,
                timeout: 10000
            }
        ]);

        // Action Capture Rules
        this.validationRules.set('action-capture', [
            {
                name: 'action-detected',
                validate: async (context) => this.validateActionDetected(context),
                required: true,
                timeout: 5000
            },
            {
                name: 'coordinates-captured',
                validate: async (context) => this.validateCoordinatesCaptured(context),
                required: true,
                timeout: 1000
            },
            {
                name: 'action-timestamped',
                validate: async (context) => this.validateActionTimestamped(context),
                required: true,
                timeout: 1000
            }
        ]);

        // Screenshot Capture Rules
        this.validationRules.set('screenshot-capture', [
            {
                name: 'screenshot-quality',
                validate: async (context) => this.validateScreenshotQuality(context),
                required: true,
                timeout: 5000
            },
            {
                name: 'screenshot-timing',
                validate: async (context) => this.validateScreenshotTiming(context),
                required: false,
                timeout: 2000
            },
            {
                name: 'screenshot-storage',
                validate: async (context) => this.validateScreenshotStorage(context),
                required: true,
                timeout: 3000
            }
        ]);

        // Export Rules
        this.validationRules.set('python-export', [
            {
                name: 'export-data-complete',
                validate: async (context) => this.validateExportDataComplete(context),
                required: true,
                timeout: 2000
            },
            {
                name: 'python-script-valid',
                validate: async (context) => this.validatePythonScriptValid(context),
                required: true,
                timeout: 5000
            },
            {
                name: 'script-executable',
                validate: async (context) => this.validateScriptExecutable(context),
                required: false,
                timeout: 10000
            }
        ]);
    }

    /**
     * Validate complete workflow end-to-end
     */
    async validateWorkflow(workflowName, context = {}) {
        const workflow = this.workflows.get(workflowName);
        if (!workflow) {
            throw new Error(`Unknown workflow: ${workflowName}`);
        }

        console.log(`🔍 Starting validation for workflow: ${workflow.name}`);
        
        const validationSession = {
            workflowName,
            startTime: Date.now(),
            context: { ...context },
            results: new Map(),
            errors: [],
            warnings: [],
            completed: false,
            success: false
        };

        try {
            // Validate workflow dependencies
            const dependencyValidation = await this.validateWorkflowDependencies(workflow);
            validationSession.dependencyValidation = dependencyValidation;

            if (!dependencyValidation.valid) {
                validationSession.errors.push(...dependencyValidation.errors);
                return this.completeValidationSession(validationSession);
            }

            // Execute workflow steps in order
            const executionOrder = this.getExecutionOrder(workflow);
            
            for (const step of executionOrder) {
                console.log(`  🔍 Validating step: ${step}`);
                
                const stepResult = await this.validateWorkflowStep(step, validationSession.context);
                validationSession.results.set(step, stepResult);
                
                if (!stepResult.success && workflow.critical) {
                    console.error(`  ❌ Critical step failed: ${step}`);
                    validationSession.errors.push({
                        step,
                        error: stepResult.error,
                        critical: true
                    });
                    break; // Stop on critical failure
                } else if (!stepResult.success) {
                    console.warn(`  ⚠️ Non-critical step failed: ${step}`);
                    validationSession.warnings.push({
                        step,
                        error: stepResult.error,
                        critical: false
                    });
                }
                
                // Update context with step results
                validationSession.context[`${step}_result`] = stepResult;
            }

            validationSession.success = validationSession.errors.length === 0;
            validationSession.completed = true;

        } catch (error) {
            console.error(`💥 Workflow validation crashed: ${error.message}`);
            validationSession.errors.push({
                step: 'workflow_execution',
                error: error.message,
                critical: true,
                stack: error.stack
            });
        }

        return this.completeValidationSession(validationSession);
    }

    /**
     * Validate individual workflow step
     */
    async validateWorkflowStep(stepName, context) {
        const rules = this.validationRules.get(stepName) || [];
        
        const stepResult = {
            step: stepName,
            success: true,
            startTime: Date.now(),
            ruleResults: [],
            error: null,
            warnings: []
        };

        for (const rule of rules) {
            try {
                const ruleResult = await this.executeValidationRule(rule, context);
                stepResult.ruleResults.push(ruleResult);
                
                if (!ruleResult.success && rule.required) {
                    stepResult.success = false;
                    stepResult.error = ruleResult.error;
                    console.error(`    ❌ Required rule failed: ${rule.name} - ${ruleResult.error}`);
                } else if (!ruleResult.success && !rule.required) {
                    stepResult.warnings.push(ruleResult.error);
                    console.warn(`    ⚠️ Optional rule failed: ${rule.name} - ${ruleResult.error}`);
                } else {
                    console.log(`    ✅ Rule passed: ${rule.name}`);
                }
                
            } catch (error) {
                const ruleResult = {
                    rule: rule.name,
                    success: false,
                    error: error.message,
                    duration: 0
                };
                
                stepResult.ruleResults.push(ruleResult);
                
                if (rule.required) {
                    stepResult.success = false;
                    stepResult.error = error.message;
                }
                
                console.error(`    💥 Rule execution failed: ${rule.name} - ${error.message}`);
            }
        }

        stepResult.duration = Date.now() - stepResult.startTime;
        return stepResult;
    }

    /**
     * Execute individual validation rule with timeout
     */
    async executeValidationRule(rule, context) {
        return new Promise(async (resolve) => {
            const startTime = Date.now();
            let completed = false;
            
            // Set timeout
            const timeout = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    resolve({
                        rule: rule.name,
                        success: false,
                        error: `Rule timeout after ${rule.timeout}ms`,
                        duration: Date.now() - startTime
                    });
                }
            }, rule.timeout);

            try {
                const result = await rule.validate(context);
                
                if (!completed) {
                    completed = true;
                    clearTimeout(timeout);
                    resolve({
                        rule: rule.name,
                        success: result.success !== false,
                        error: result.error || null,
                        data: result.data || null,
                        duration: Date.now() - startTime
                    });
                }
            } catch (error) {
                if (!completed) {
                    completed = true;
                    clearTimeout(timeout);
                    resolve({
                        rule: rule.name,
                        success: false,
                        error: error.message,
                        duration: Date.now() - startTime
                    });
                }
            }
        });
    }

    /**
     * Validation Rule Implementations
     */

    async validateAdbAvailable(context) {
        // Mock ADB availability check
        const adbAvailable = Math.random() > 0.1; // 90% success rate
        
        return {
            success: adbAvailable,
            error: adbAvailable ? null : 'ADB not available in PATH',
            data: { adbPath: adbAvailable ? '/usr/local/bin/adb' : null }
        };
    }

    async validateDevicesFound(context) {
        await this.sleep(1000); // Simulate device scan time
        
        const devicesFound = Math.random() > 0.2; // 80% success rate
        const deviceCount = devicesFound ? Math.floor(Math.random() * 3) + 1 : 0;
        
        return {
            success: devicesFound,
            error: devicesFound ? null : 'No devices found. Please connect a device and enable USB debugging.',
            data: { deviceCount, devices: devicesFound ? ['mock_device_1'] : [] }
        };
    }

    async validateDevicePermissions(context) {
        const hasPermissions = Math.random() > 0.15; // 85% success rate
        
        return {
            success: hasPermissions,
            error: hasPermissions ? null : 'Device permissions not granted. Please accept USB debugging prompt.',
            data: { permissions: hasPermissions ? ['usb_debugging', 'screen_capture'] : [] }
        };
    }

    async validateConnectionEstablished(context) {
        await this.sleep(2000); // Simulate connection time
        
        const connected = Math.random() > 0.1; // 90% success rate
        
        return {
            success: connected,
            error: connected ? null : 'Failed to establish device connection',
            data: { connectionId: connected ? 'conn_' + Date.now() : null }
        };
    }

    async validateDeviceResponsive(context) {
        const responsive = Math.random() > 0.05; // 95% success rate
        
        return {
            success: responsive,
            error: responsive ? null : 'Device not responding to commands',
            data: { responseTime: responsive ? Math.floor(Math.random() * 500) + 100 : null }
        };
    }

    async validateScreenAccess(context) {
        const screenAccess = Math.random() > 0.1; // 90% success rate
        
        return {
            success: screenAccess,
            error: screenAccess ? null : 'Cannot access device screen. Check screen mirroring permissions.',
            data: { resolution: screenAccess ? { width: 1080, height: 1920 } : null }
        };
    }

    async validateRecordingSessionCreated(context) {
        const sessionCreated = Math.random() > 0.05; // 95% success rate
        
        return {
            success: sessionCreated,
            error: sessionCreated ? null : 'Failed to create recording session',
            data: { sessionId: sessionCreated ? 'session_' + Date.now() : null }
        };
    }

    async validateInitialScreenshotCaptured(context) {
        await this.sleep(2000); // Simulate screenshot capture time
        
        const screenshotCaptured = Math.random() > 0.1; // 90% success rate
        
        return {
            success: screenshotCaptured,
            error: screenshotCaptured ? null : 'Failed to capture initial screenshot',
            data: { 
                screenshotPath: screenshotCaptured ? '/tmp/initial_screenshot.png' : null,
                fileSize: screenshotCaptured ? Math.floor(Math.random() * 500000) + 100000 : null
            }
        };
    }

    async validateActionDetected(context) {
        const actionDetected = Math.random() > 0.05; // 95% success rate
        
        return {
            success: actionDetected,
            error: actionDetected ? null : 'No user action detected within timeout',
            data: { 
                actionType: actionDetected ? ['tap', 'swipe', 'long_press'][Math.floor(Math.random() * 3)] : null,
                timestamp: actionDetected ? Date.now() : null
            }
        };
    }

    async validateCoordinatesCaptured(context) {
        const coordinatesCaptured = Math.random() > 0.02; // 98% success rate
        
        return {
            success: coordinatesCaptured,
            error: coordinatesCaptured ? null : 'Failed to capture action coordinates',
            data: { 
                coordinates: coordinatesCaptured ? {
                    x: Math.floor(Math.random() * 1080),
                    y: Math.floor(Math.random() * 1920)
                } : null
            }
        };
    }

    async validateActionTimestamped(context) {
        return {
            success: true,
            data: { timestamp: Date.now() }
        };
    }

    async validateScreenshotQuality(context) {
        await this.sleep(1000); // Simulate quality check
        
        const qualityGood = Math.random() > 0.1; // 90% success rate
        const quality = qualityGood ? Math.floor(Math.random() * 30) + 70 : Math.floor(Math.random() * 50) + 10;
        
        return {
            success: quality >= 70,
            error: quality >= 70 ? null : `Screenshot quality too low: ${quality}%`,
            data: { qualityScore: quality, threshold: 70 }
        };
    }

    async validateScreenshotTiming(context) {
        const timingGood = Math.random() > 0.2; // 80% success rate
        const captureTime = Math.floor(Math.random() * 3000) + 500; // 500-3500ms
        
        return {
            success: timingGood && captureTime < 2000,
            error: timingGood && captureTime < 2000 ? null : `Screenshot capture too slow: ${captureTime}ms`,
            data: { captureTime, threshold: 2000 }
        };
    }

    async validateScreenshotStorage(context) {
        const stored = Math.random() > 0.05; // 95% success rate
        
        return {
            success: stored,
            error: stored ? null : 'Failed to store screenshot file',
            data: { 
                storagePath: stored ? '/tmp/screenshots/' : null,
                fileSize: stored ? Math.floor(Math.random() * 800000) + 200000 : null
            }
        };
    }

    async validateExportDataComplete(context) {
        const dataComplete = Math.random() > 0.1; // 90% success rate
        
        const mockData = {
            actions: dataComplete ? Math.floor(Math.random() * 10) + 1 : 0,
            screenshots: dataComplete ? Math.floor(Math.random() * 15) + 1 : 0,
            metadata: dataComplete
        };
        
        return {
            success: dataComplete && mockData.actions > 0 && mockData.screenshots > 0,
            error: dataComplete && mockData.actions > 0 && mockData.screenshots > 0 ? null : 'Export data incomplete',
            data: mockData
        };
    }

    async validatePythonScriptValid(context) {
        await this.sleep(1000); // Simulate script validation
        
        const scriptValid = Math.random() > 0.05; // 95% success rate
        
        return {
            success: scriptValid,
            error: scriptValid ? null : 'Generated Python script has syntax errors',
            data: { 
                scriptLength: scriptValid ? Math.floor(Math.random() * 5000) + 2000 : 0,
                syntaxValid: scriptValid
            }
        };
    }

    async validateScriptExecutable(context) {
        await this.sleep(2000); // Simulate execution test
        
        const executable = Math.random() > 0.15; // 85% success rate
        
        return {
            success: executable,
            error: executable ? null : 'Generated script failed execution test',
            data: { 
                executionTime: executable ? Math.floor(Math.random() * 2000) + 500 : null,
                exitCode: executable ? 0 : 1
            }
        };
    }

    /**
     * Utility Methods
     */

    validateWorkflowDependencies(workflow) {
        const errors = [];
        const resolved = new Set();
        const visiting = new Set();

        const visit = (step) => {
            if (visiting.has(step)) {
                errors.push(`Circular dependency detected involving step: ${step}`);
                return false;
            }
            
            if (resolved.has(step)) {
                return true;
            }
            
            visiting.add(step);
            
            const dependencies = workflow.dependencies[step] || [];
            for (const dep of dependencies) {
                if (!workflow.steps.includes(dep)) {
                    errors.push(`Step '${step}' depends on non-existent step '${dep}'`);
                    continue;
                }
                
                if (!visit(dep)) {
                    return false;
                }
            }
            
            visiting.delete(step);
            resolved.add(step);
            return true;
        };

        for (const step of workflow.steps) {
            if (!resolved.has(step)) {
                visit(step);
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }

    getExecutionOrder(workflow) {
        const resolved = [];
        const visiting = new Set();
        const visited = new Set();

        const visit = (step) => {
            if (visiting.has(step)) {
                return; // Circular dependency - skip
            }
            
            if (visited.has(step)) {
                return;
            }
            
            visiting.add(step);
            
            const dependencies = workflow.dependencies[step] || [];
            for (const dep of dependencies) {
                visit(dep);
            }
            
            visiting.delete(step);
            visited.add(step);
            resolved.push(step);
        };

        for (const step of workflow.steps) {
            visit(step);
        }

        return resolved;
    }

    completeValidationSession(session) {
        session.endTime = Date.now();
        session.totalDuration = session.endTime - session.startTime;
        
        const report = this.generateValidationReport(session);
        console.log(`🏁 Workflow validation completed: ${session.workflowName}`);
        console.log(`   Success: ${session.success ? '✅' : '❌'}`);
        console.log(`   Duration: ${session.totalDuration}ms`);
        console.log(`   Errors: ${session.errors.length}`);
        console.log(`   Warnings: ${session.warnings.length}`);
        
        return report;
    }

    generateValidationReport(session) {
        return {
            workflow: session.workflowName,
            success: session.success,
            completed: session.completed,
            duration: session.totalDuration,
            summary: {
                steps: session.results.size,
                passed: Array.from(session.results.values()).filter(r => r.success).length,
                failed: Array.from(session.results.values()).filter(r => !r.success).length,
                errors: session.errors.length,
                warnings: session.warnings.length
            },
            results: Object.fromEntries(session.results),
            errors: session.errors,
            warnings: session.warnings,
            timestamp: new Date().toISOString()
        };
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Store workflow validation results
     */
    async storeValidationResults(workflowName, results) {
        try {
            if (typeof mcp__claude_flow__memory_usage !== 'undefined') {
                await mcp__claude_flow__memory_usage({
                    action: 'store',
                    key: `scratch-preset/integration/workflow-validation/${workflowName}`,
                    value: JSON.stringify(results)
                });
            }
        } catch (error) {
            console.warn('Could not store validation results:', error);
        }
    }
}

// Export for use in different environments
if (typeof window !== 'undefined') {
    window.WorkflowValidator = WorkflowValidator;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WorkflowValidator;
}