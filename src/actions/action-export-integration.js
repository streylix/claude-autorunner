/**
 * Action Export Integration - Integrates action sequences with the preset export system
 * Provides seamless export of recorded actions as part of preset data
 */

class ActionExportIntegration {
    constructor(options = {}) {
        this.options = {
            // Export settings
            includeCoordinateMapping: options.includeCoordinateMapping !== false,
            includeDeviceInfo: options.includeDeviceInfo !== false,
            includeTimingData: options.includeTimingData !== false,
            includeMetadata: options.includeMetadata !== false,
            
            // Coordinate settings
            exportUICoordinates: options.exportUICoordinates || false,
            exportDeviceCoordinates: options.exportDeviceCoordinates !== false,
            coordinatePrecision: options.coordinatePrecision || 2,
            
            // Screenshot integration
            includeScreenshots: options.includeScreenshots !== false,
            screenshotAssociation: options.screenshotAssociation || 'sequence', // 'sequence', 'action', 'none'
            
            // Format settings
            exportFormat: options.exportFormat || 'json', // 'json', 'python', 'yaml'
            prettifyOutput: options.prettifyOutput !== false,
            compressData: options.compressData || false,
            
            // Python export settings
            pythonClassName: options.pythonClassName || 'ActionSequence',
            pythonModuleName: options.pythonModuleName || 'device_actions',
            includeExecutionMethods: options.includeExecutionMethods !== false
        };
        
        this.state = {
            isInitialized: false,
            exportCount: 0,
            lastExportTime: null,
            errors: []
        };
        
        // Template storage
        this.templates = new Map();
        
        // Initialize templates
        this.initializeTemplates();
    }
    
    /**
     * Initialize export templates
     */
    initializeTemplates() {
        // JSON template
        this.templates.set('json', {
            name: 'JSON Export',
            extension: 'json',
            mimeType: 'application/json',
            generator: this.generateJSONExport.bind(this)
        });
        
        // Python template
        this.templates.set('python', {
            name: 'Python Script',
            extension: 'py',
            mimeType: 'text/x-python',
            generator: this.generatePythonExport.bind(this)
        });
        
        // YAML template
        this.templates.set('yaml', {
            name: 'YAML Export',
            extension: 'yaml',
            mimeType: 'text/yaml',
            generator: this.generateYAMLExport.bind(this)
        });
    }
    
    /**
     * Export action sequences for preset integration
     */
    exportForPreset(sequences, presetData = {}, exportOptions = {}) {
        const options = { ...this.options, ...exportOptions };
        
        try {
            const exportData = {
                // Preset metadata
                preset: {
                    id: presetData.id || `preset_${Date.now()}`,
                    name: presetData.name || 'Unnamed Preset',
                    description: presetData.description || 'Preset with recorded actions',
                    version: presetData.version || '1.0.0',
                    createdAt: new Date().toISOString(),
                    ...presetData
                },
                
                // Action sequences
                actionSequences: this.processSequencesForExport(sequences, options),
                
                // Export metadata
                exportMetadata: {
                    exportedAt: new Date().toISOString(),
                    exportedBy: 'action-export-integration',
                    exportVersion: '1.0.0',
                    options: options,
                    sequenceCount: sequences.length,
                    totalActions: sequences.reduce((sum, seq) => sum + (seq.actions?.length || 0), 0)
                }
            };
            
            // Include screenshots if enabled
            if (options.includeScreenshots) {
                exportData.screenshots = this.processScreenshotsForExport(sequences, options);
            }
            
            // Include device information
            if (options.includeDeviceInfo) {
                exportData.deviceInfo = this.extractDeviceInfo(sequences);
            }
            
            // Include coordinate mapping data
            if (options.includeCoordinateMapping) {
                exportData.coordinateMapping = this.extractCoordinateMapping(sequences);
            }
            
            this.state.exportCount++;
            this.state.lastExportTime = Date.now();
            
            return {
                success: true,
                data: exportData,
                format: options.exportFormat,
                metadata: exportData.exportMetadata
            };
            
        } catch (error) {
            this.state.errors.push({
                timestamp: Date.now(),
                error: error.message,
                type: 'export'
            });
            
            return {
                success: false,
                error: error.message,
                format: options.exportFormat
            };
        }
    }
    
    /**
     * Process sequences for export
     */
    processSequencesForExport(sequences, options) {
        return sequences.map(sequence => {
            const processedSequence = {
                id: sequence.id,
                name: sequence.name,
                duration: sequence.duration,
                actionCount: sequence.actions?.length || 0,
                actions: this.processActionsForExport(sequence.actions || [], options)
            };
            
            // Include timing data if enabled
            if (options.includeTimingData) {
                processedSequence.startTime = sequence.startTime;
                processedSequence.endTime = sequence.endTime;
                processedSequence.relativeTimings = this.calculateRelativeTimings(sequence.actions || []);
            }
            
            // Include metadata if enabled
            if (options.includeMetadata) {
                processedSequence.metadata = sequence.metadata;
                processedSequence.deviceInfo = sequence.deviceInfo;
                processedSequence.displayBounds = sequence.displayBounds;
            }
            
            return processedSequence;
        });
    }
    
    /**
     * Process actions for export
     */
    processActionsForExport(actions, options) {
        return actions.map(action => {
            const processedAction = {
                id: action.id,
                type: action.type,
                relativeTime: action.relativeTime
            };
            
            // Include coordinates based on options
            if (options.exportDeviceCoordinates && action.deviceCoordinates) {
                processedAction.deviceCoordinates = {
                    x: parseFloat(action.deviceCoordinates.x?.toFixed(options.coordinatePrecision) || 0),
                    y: parseFloat(action.deviceCoordinates.y?.toFixed(options.coordinatePrecision) || 0)
                };
                
                // Include end coordinates for drag/swipe actions
                if (action.deviceCoordinates.endX !== undefined) {
                    processedAction.deviceCoordinates.endX = parseFloat(action.deviceCoordinates.endX?.toFixed(options.coordinatePrecision) || 0);
                    processedAction.deviceCoordinates.endY = parseFloat(action.deviceCoordinates.endY?.toFixed(options.coordinatePrecision) || 0);
                }
            }
            
            if (options.exportUICoordinates && action.uiCoordinates) {
                processedAction.uiCoordinates = {
                    x: parseFloat(action.uiCoordinates.clientX?.toFixed(options.coordinatePrecision) || 0),
                    y: parseFloat(action.uiCoordinates.clientY?.toFixed(options.coordinatePrecision) || 0)
                };
                
                // Include end coordinates for drag/swipe actions
                if (action.uiCoordinates.endX !== undefined) {
                    processedAction.uiCoordinates.endX = parseFloat(action.uiCoordinates.endX?.toFixed(options.coordinatePrecision) || 0);
                    processedAction.uiCoordinates.endY = parseFloat(action.uiCoordinates.endY?.toFixed(options.coordinatePrecision) || 0);
                }
            }
            
            // Include action-specific metadata
            if (action.metadata) {
                if (action.metadata.duration) processedAction.duration = action.metadata.duration;
                if (action.metadata.direction) processedAction.direction = action.metadata.direction;
                if (action.metadata.velocity) processedAction.velocity = action.metadata.velocity;
            }
            
            return processedAction;
        });
    }
    
    /**
     * Process screenshots for export
     */
    processScreenshotsForExport(sequences, options) {
        const screenshots = [];
        
        sequences.forEach(sequence => {
            if (sequence.screenshots) {
                sequence.screenshots.forEach(screenshot => {
                    screenshots.push({
                        id: screenshot.id,
                        filename: screenshot.filename,
                        relativePath: screenshot.relativePath,
                        timestamp: screenshot.timestamp,
                        sequenceId: sequence.id,
                        type: screenshot.type || 'sequence-related'
                    });
                });
            }
        });
        
        return screenshots;
    }
    
    /**
     * Extract device information from sequences
     */
    extractDeviceInfo(sequences) {
        const deviceInfoSet = new Set();
        
        sequences.forEach(sequence => {
            if (sequence.deviceInfo) {
                deviceInfoSet.add(JSON.stringify(sequence.deviceInfo));
            }
        });
        
        return Array.from(deviceInfoSet).map(info => JSON.parse(info));
    }
    
    /**
     * Extract coordinate mapping information
     */
    extractCoordinateMapping(sequences) {
        const mappingData = {
            scalingFactors: new Set(),
            displayBounds: new Set(),
            coordinateSystems: new Set()
        };
        
        sequences.forEach(sequence => {
            if (sequence.displayBounds) {
                mappingData.displayBounds.add(JSON.stringify(sequence.displayBounds));
            }
            
            sequence.actions?.forEach(action => {
                if (action.metadata?.scaleFactor) {
                    mappingData.scalingFactors.add(action.metadata.scaleFactor);
                }
            });
        });
        
        return {
            scalingFactors: Array.from(mappingData.scalingFactors),
            displayBounds: Array.from(mappingData.displayBounds).map(bounds => JSON.parse(bounds)),
            coordinateSystems: Array.from(mappingData.coordinateSystems)
        };
    }
    
    /**
     * Calculate relative timings for actions
     */
    calculateRelativeTimings(actions) {
        if (actions.length === 0) return [];
        
        const startTime = Math.min(...actions.map(a => a.timestamp));
        
        return actions.map(action => ({
            actionId: action.id,
            relativeTime: action.timestamp - startTime,
            normalizedTime: (action.timestamp - startTime) / (actions[actions.length - 1].timestamp - startTime)
        }));
    }
    
    /**
     * Generate JSON export
     */
    generateJSONExport(exportData, options) {
        const jsonString = options.prettifyOutput ? 
            JSON.stringify(exportData, null, 2) : 
            JSON.stringify(exportData);
        
        return {
            content: jsonString,
            filename: `${exportData.preset.name.replace(/[^a-z0-9]/gi, '_')}_actions.json`,
            mimeType: 'application/json'
        };
    }
    
    /**
     * Generate Python export
     */
    generatePythonExport(exportData, options) {
        const className = options.pythonClassName || this.options.pythonClassName;
        const moduleName = options.pythonModuleName || this.options.pythonModuleName;
        
        const pythonCode = `#!/usr/bin/env python3
"""
${exportData.preset.name} - Device Action Automation
Generated by Action Export Integration

Description: ${exportData.preset.description}
Created: ${exportData.exportMetadata.exportedAt}
Total Sequences: ${exportData.actionSequences.length}
Total Actions: ${exportData.exportMetadata.totalActions}
"""

import time
import json
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass


@dataclass
class ActionCoordinates:
    """Represents action coordinates"""
    x: float
    y: float
    end_x: Optional[float] = None
    end_y: Optional[float] = None


@dataclass  
class DeviceAction:
    """Represents a single device action"""
    id: str
    type: str
    relative_time: int
    coordinates: ActionCoordinates
    duration: Optional[int] = None
    direction: Optional[str] = None
    velocity: Optional[float] = None


@dataclass
class ActionSequence:
    """Represents a sequence of device actions"""
    id: str
    name: str
    duration: int
    actions: List[DeviceAction]


class ${className}:
    """Main class for executing device actions"""
    
    def __init__(self):
        self.sequences = self._load_sequences()
        self.current_sequence = None
        
    def _load_sequences(self) -> List[ActionSequence]:
        """Load action sequences from embedded data"""
        sequences_data = ${JSON.stringify(exportData.actionSequences, null, 8)}
        
        sequences = []
        for seq_data in sequences_data:
            actions = []
            for action_data in seq_data['actions']:
                coords = ActionCoordinates(
                    x=action_data['deviceCoordinates']['x'],
                    y=action_data['deviceCoordinates']['y'],
                    end_x=action_data['deviceCoordinates'].get('endX'),
                    end_y=action_data['deviceCoordinates'].get('endY')
                )
                
                action = DeviceAction(
                    id=action_data['id'],
                    type=action_data['type'],
                    relative_time=action_data['relativeTime'],
                    coordinates=coords,
                    duration=action_data.get('duration'),
                    direction=action_data.get('direction'),
                    velocity=action_data.get('velocity')
                )
                actions.append(action)
            
            sequence = ActionSequence(
                id=seq_data['id'],
                name=seq_data['name'],
                duration=seq_data['duration'],
                actions=actions
            )
            sequences.append(sequence)
        
        return sequences
    
    def get_sequences(self) -> List[ActionSequence]:
        """Get all available action sequences"""
        return self.sequences
    
    def get_sequence_by_name(self, name: str) -> Optional[ActionSequence]:
        """Get sequence by name"""
        for sequence in self.sequences:
            if sequence.name == name:
                return sequence
        return None
    
    def execute_sequence(self, sequence_name: str, dry_run: bool = False) -> bool:
        """Execute a named action sequence"""
        sequence = self.get_sequence_by_name(sequence_name)
        if not sequence:
            print(f"Sequence '{sequence_name}' not found")
            return False
        
        return self.execute_sequence_obj(sequence, dry_run)
    
    def execute_sequence_obj(self, sequence: ActionSequence, dry_run: bool = False) -> bool:
        """Execute an action sequence object"""
        print(f"Executing sequence: {sequence.name}")
        print(f"Actions: {len(sequence.actions)}")
        print(f"Duration: {sequence.duration}ms")
        
        if dry_run:
            print("DRY RUN - Actions will be logged but not executed")
        
        start_time = time.time() * 1000
        
        for action in sequence.actions:
            # Wait for relative timing
            current_time = time.time() * 1000
            elapsed = current_time - start_time
            
            if action.relative_time > elapsed:
                wait_time = (action.relative_time - elapsed) / 1000
                if not dry_run:
                    time.sleep(wait_time)
            
            # Execute action
            self._execute_action(action, dry_run)
        
        print(f"Sequence '{sequence.name}' completed")
        return True
    
    def _execute_action(self, action: DeviceAction, dry_run: bool = False):
        """Execute a single action"""
        print(f"  {action.type.upper()}: ({action.coordinates.x}, {action.coordinates.y})")
        
        if dry_run:
            return
        
        # This is where you would integrate with your device control library
        # For example, using ADB for Android devices:
        
        if action.type == 'click':
            self._adb_tap(action.coordinates.x, action.coordinates.y)
        elif action.type == 'drag':
            self._adb_swipe(
                action.coordinates.x, action.coordinates.y,
                action.coordinates.end_x, action.coordinates.end_y,
                action.duration or 500
            )
        elif action.type == 'longpress':
            self._adb_long_press(action.coordinates.x, action.coordinates.y, action.duration or 1000)
        # Add more action types as needed
    
    def _adb_tap(self, x: float, y: float):
        """Execute ADB tap command"""
        # Example: subprocess.run(['adb', 'shell', 'input', 'tap', str(x), str(y)])
        print(f"    ADB TAP: {x}, {y}")
    
    def _adb_swipe(self, x1: float, y1: float, x2: float, y2: float, duration: int):
        """Execute ADB swipe command"""
        # Example: subprocess.run(['adb', 'shell', 'input', 'swipe', str(x1), str(y1), str(x2), str(y2), str(duration)])
        print(f"    ADB SWIPE: {x1},{y1} -> {x2},{y2} ({duration}ms)")
    
    def _adb_long_press(self, x: float, y: float, duration: int):
        """Execute ADB long press command"""
        # Example: Use swipe with same start/end coordinates
        print(f"    ADB LONG PRESS: {x}, {y} ({duration}ms)")


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='${exportData.preset.name} - Device Action Automation')
    parser.add_argument('sequence', nargs='?', help='Sequence name to execute')
    parser.add_argument('--list', action='store_true', help='List available sequences')
    parser.add_argument('--dry-run', action='store_true', help='Show actions without executing')
    
    args = parser.parse_args()
    
    executor = ${className}()
    
    if args.list:
        print("Available sequences:")
        for sequence in executor.get_sequences():
            print(f"  {sequence.name} ({len(sequence.actions)} actions, {sequence.duration}ms)")
        return
    
    if not args.sequence:
        parser.error("Please specify a sequence name or use --list")
    
    success = executor.execute_sequence(args.sequence, args.dry_run)
    exit(0 if success else 1)


if __name__ == '__main__':
    main()
`;
        
        return {
            content: pythonCode,
            filename: `${moduleName}.py`,
            mimeType: 'text/x-python'
        };
    }
    
    /**
     * Generate YAML export
     */
    generateYAMLExport(exportData, options) {
        // Convert to YAML format (simplified version)
        const yamlContent = this.objectToYAML(exportData, 0);
        
        return {
            content: yamlContent,
            filename: `${exportData.preset.name.replace(/[^a-z0-9]/gi, '_')}_actions.yaml`,
            mimeType: 'text/yaml'
        };
    }
    
    /**
     * Simple object to YAML converter
     */
    objectToYAML(obj, indent = 0) {
        const spaces = '  '.repeat(indent);
        let yaml = '';
        
        if (Array.isArray(obj)) {
            obj.forEach(item => {
                yaml += `${spaces}- `;
                if (typeof item === 'object' && item !== null) {
                    yaml += '\n' + this.objectToYAML(item, indent + 1);
                } else {
                    yaml += `${item}\n`;
                }
            });
        } else if (typeof obj === 'object' && obj !== null) {
            Object.entries(obj).forEach(([key, value]) => {
                yaml += `${spaces}${key}: `;
                if (typeof value === 'object' && value !== null) {
                    yaml += '\n' + this.objectToYAML(value, indent + 1);
                } else {
                    yaml += `${value}\n`;
                }
            });
        } else {
            yaml += `${spaces}${obj}\n`;
        }
        
        return yaml;
    }
    
    /**
     * Export to file (browser environment)
     */
    exportToFile(exportData, format = 'json', options = {}) {
        const template = this.templates.get(format);
        if (!template) {
            throw new Error(`Unsupported export format: ${format}`);
        }
        
        const result = template.generator(exportData, options);
        
        // Create downloadable blob
        const blob = new Blob([result.content], { type: result.mimeType });
        const url = URL.createObjectURL(blob);
        
        // Trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename;
        a.click();
        
        URL.revokeObjectURL(url);
        
        return {
            success: true,
            filename: result.filename,
            format: format,
            size: result.content.length
        };
    }
    
    /**
     * Get available export formats
     */
    getAvailableFormats() {
        return Array.from(this.templates.entries()).map(([key, template]) => ({
            key,
            name: template.name,
            extension: template.extension,
            mimeType: template.mimeType
        }));
    }
    
    /**
     * Get export statistics
     */
    getStatistics() {
        return {
            isInitialized: this.state.isInitialized,
            exportCount: this.state.exportCount,
            lastExportTime: this.state.lastExportTime,
            errorCount: this.state.errors.length,
            availableFormats: this.getAvailableFormats().length
        };
    }
    
    /**
     * Cleanup
     */
    cleanup() {
        this.templates.clear();
        this.state.errors = [];
    }
}

// Export for both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ActionExportIntegration;
} else if (typeof window !== 'undefined') {
    window.ActionExportIntegration = ActionExportIntegration;
}