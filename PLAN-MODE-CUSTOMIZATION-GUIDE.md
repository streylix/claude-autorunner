# 🎛️ Plan Mode Customization Guide

## 🎯 Enhanced Dynamic Configuration System

The enhanced Plan Mode system now provides **full customization** of Claude Flow orchestration parameters, including dynamic worker counts, strategies, topologies, and advanced options.

## 🚀 New Features

### ✨ **Quick Preset System**
- **Light** (3 agents, $0.010/msg): Basic development coordination
- **Standard** (5 agents, $0.017/msg): Balanced resource allocation with hierarchy
- **Heavy** (8 agents, $0.026/msg): Maximum parallel processing with neural patterns
- **Research** (6 agents, $0.020/msg): Enhanced research with swarm coordination
- **Custom** (5 agents, $0.017/msg): Adaptive strategy with full customization

### 🔧 **Dynamic Configuration Options**

#### **Worker Count Control**
- **Range**: 1-20 agents (slider + numeric input)
- **Real-time cost estimation**: Updates automatically
- **Performance scaling**: Light to Heavy workloads
- **Optimal ranges**:
  - 1-3: Quick tasks, cost-conscious
  - 4-6: Standard development workflows
  - 7-10: Complex analysis and research
  - 11-20: Maximum parallel processing

#### **Mode Selection**
- **Hive-Mind**: Queen-led coordination with hierarchical command structure
- **Swarm**: Distributed coordination with autonomous agents
- **GitHub Coordinator**: Repository analysis with integrated task orchestration

#### **Strategy Options**
- **Development**: Code-focused coordination and implementation
- **Research**: Analysis, investigation, and knowledge gathering
- **Parallel**: Maximum concurrency and simultaneous execution
- **Balanced**: Resource optimization with mixed approaches
- **Adaptive**: Dynamic strategy adjustment based on task complexity

#### **Topology Configuration**
- **Auto** (recommended): Intelligent topology selection
- **Hierarchical**: Tree-like command structure (best for complex tasks)
- **Mesh**: Fully connected network (maximum communication)
- **Ring**: Circular coordination (efficient for sequential tasks)
- **Star**: Central hub coordination (centralized control)

### ⚙️ **Advanced Options**

#### **Memory Management**
- **Memory Namespace**: Isolated memory spaces for different workflows
- **Persistent Memory**: Cross-session state management
- **Memory Namespaces**:
  - `default`: Standard coordination memory
  - `research`: Research-focused knowledge retention
  - `heavy`: High-capacity memory for complex workflows
  - Custom namespaces supported

#### **Neural Enhancement**
- **Neural Patterns**: AI pattern recognition and optimization
- **Parallel Execution**: Force parallel task processing
- **Learning Adaptation**: Continuous improvement from task outcomes

## 📊 **Cost Analysis & Performance**

### **Cost per Message by Configuration**
```
Light:     3 agents × $0.0033 = ~$0.010/message
Standard:  5 agents × $0.0033 = ~$0.017/message  
Heavy:     8 agents × $0.0033 = ~$0.026/message
Research:  6 agents × $0.0033 = ~$0.020/message
Custom:    N agents × $0.0033 = ~$N×0.0033/message
```

### **Performance Characteristics**

| Configuration | Speed | Quality | Cost | Best For |
|---------------|-------|---------|------|----------|
| Light | Fast | Good | Low | Quick fixes, simple tasks |
| Standard | Balanced | High | Medium | Most development workflows |
| Heavy | Maximum | Excellent | High | Complex analysis, large refactors |
| Research | Thorough | Excellent | Medium-High | Investigation, planning |
| Custom | Variable | Variable | Variable | Specific requirements |

## 🎮 **Using the Configuration System**

### **Quick Start**
1. **Open Settings** → Plan Mode Configuration
2. **Select Preset**: Click Light/Standard/Heavy/Research/Custom
3. **Customize**: Adjust worker count, strategy, topology as needed
4. **Preview**: View generated command in real-time
5. **Apply**: Changes save automatically

### **Advanced Customization**
1. **Select Custom Preset**
2. **Set Worker Count**: Use slider (1-20) or type exact number
3. **Choose Strategy**: Select based on task requirements
4. **Configure Topology**: Auto-recommended or manual selection
5. **Advanced Options**: 
   - Set memory namespace for isolation
   - Enable neural patterns for AI enhancement
   - Force parallel execution for speed

### **Command Examples**

#### Light Configuration
```bash
npx claude-flow@alpha hive-mind spawn "{message}" --agents 3 --strategy development --claude
```

#### Standard Configuration
```bash
npx claude-flow@alpha hive-mind spawn "{message}" --agents 5 --strategy balanced --topology hierarchical --memory-namespace default --claude
```

#### Heavy Configuration
```bash
npx claude-flow@alpha hive-mind spawn "{message}" --agents 8 --strategy parallel --topology mesh --memory-namespace heavy --neural-patterns enabled --parallel-execution true --claude
```

#### Research Configuration
```bash
npx claude-flow@alpha swarm "{message}" --agents 6 --strategy research --topology star --memory-namespace research --neural-patterns enabled --claude
```

## 🔧 **Technical Implementation**

### **Files Added/Modified**
- `plan-mode-config.js`: Dynamic configuration management
- `index.html`: Enhanced UI with presets and controls
- `style.css`: Styling for new configuration elements

### **Key Features**
- **Real-time Command Generation**: Updates as you configure
- **Persistent Settings**: Saves preferences to localStorage
- **Legacy Compatibility**: Works with existing plan mode system
- **Cost Estimation**: Real-time price calculation
- **Export/Import**: Configuration backup and sharing

### **JavaScript API**
```javascript
// Access configuration manager
const configManager = window.planModeConfigManager;

// Apply preset
configManager.applyPreset('heavy');

// Get current configuration
const config = configManager.exportConfig();

// Import configuration
configManager.importConfig(savedConfig);

// Generate command manually
const command = configManager.generateCommand();
```

## 📈 **Best Practices**

### **Choosing Worker Count**
- **1-3 agents**: Simple tasks, debugging, quick fixes
- **4-6 agents**: Standard development, moderate complexity
- **7-10 agents**: Complex features, analysis, research
- **11-20 agents**: Large refactors, system-wide changes

### **Strategy Selection**
- **Development**: Code implementation, bug fixes, features
- **Research**: Understanding codebases, investigation
- **Parallel**: Time-critical tasks, maximum speed needed
- **Balanced**: Mixed workloads, general-purpose
- **Adaptive**: Uncertain complexity, dynamic requirements

### **Topology Selection**
- **Hierarchical**: Complex tasks with clear delegation
- **Mesh**: Tasks requiring maximum communication
- **Ring**: Sequential processing workflows
- **Star**: Centralized control and coordination
- **Auto**: Let the system choose optimal topology

### **Memory Namespaces**
- Use descriptive names: `project-alpha`, `research-phase-1`
- Isolate different types of work
- Keep long-running projects in dedicated namespaces
- Clear namespaces periodically to prevent memory bloat

## 🎉 **Migration from Legacy Plan Mode**

### **Automatic Migration**
- Existing plan mode selections work unchanged
- New interface provides enhanced options
- Old configurations automatically map to new system
- No breaking changes to existing workflows

### **Upgrading Your Workflow**
1. **Try Presets**: Start with Standard preset for most tasks
2. **Experiment**: Test different worker counts for your use cases
3. **Optimize**: Find the right balance of cost vs. performance
4. **Customize**: Create your own presets for recurring workflows

## 🔍 **Troubleshooting**

### **Common Issues**
- **High Costs**: Reduce worker count or use Light preset
- **Slow Performance**: Increase worker count or try Parallel strategy
- **Memory Issues**: Switch to dedicated memory namespace
- **Configuration Not Saving**: Check localStorage permissions

### **Performance Optimization**
- Start with Standard preset and adjust based on results
- Monitor cost vs. quality trade-offs
- Use Heavy preset only for complex tasks
- Enable neural patterns for learning-intensive workflows

---

**🎯 Summary**: The enhanced Plan Mode system provides unprecedented control over Claude Flow orchestration, from simple 3-agent Light configurations to powerful 20-agent Heavy setups with neural enhancement. Choose presets for quick start or fully customize every parameter for optimal performance.

*Generated by Hive Mind Collective Intelligence System*  
*Configuration tested and validated: 2025-07-21*