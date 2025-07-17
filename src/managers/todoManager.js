/**
 * Todo Manager Module
 * 
 * Handles todo list functionality including CRUD operations, manual generation,
 * and backend integration. Extracted from TerminalGUI for better modularity.
 */

class TodoManager {
    constructor(apiClient, logAction) {
        this.apiClient = apiClient;
        this.logAction = logAction || console.log;
        this.todos = [];
        this.sessionMapping = new Map();
        this.manualGeneration = {
            selectedTerminal: 'current',
            selectedMode: 'incremental',
            customPrompt: '',
            isLoading: false
        };
        this.currentView = 'action-log'; // Track current sidebar view
    }

    /**
     * Initialize the todo system
     */
    async initializeTodoSystem() {
        try {
            // Load saved state from backend
            const savedView = await this.getSavedSidebarView();
            if (savedView) {
                this.currentView = savedView;
            }

            // Load existing todos
            await this.loadTodos();

            // Load custom prompt
            await this.loadCustomPrompt();

            // Setup event listeners
            this.setupTodoEventListeners();
            this.setupManualGenerationControls();

            this.logAction('Todo system initialized successfully', 'info');
        } catch (error) {
            this.logAction(`Failed to initialize todo system: ${error.message}`, 'error');
        }
    }

    /**
     * Setup event listeners for todo interface
     */
    setupTodoEventListeners() {
        // Switch to todos view
        const todosBtn = document.getElementById('todos-btn');
        if (todosBtn) {
            todosBtn.addEventListener('click', () => {
                this.switchSidebarView('todos');
            });
        }

        // Todo list controls
        const clearCompletedBtn = document.getElementById('clear-completed-todos');
        if (clearCompletedBtn) {
            clearCompletedBtn.addEventListener('click', () => {
                this.clearCompletedTodos();
            });
        }

        const clearAllBtn = document.getElementById('clear-all-todos');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', () => {
                this.clearAllTodos();
            });
        }

        const refreshBtn = document.getElementById('refresh-todos');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                this.refreshTodos();
            });
        }

        // Todo search
        const todoSearch = document.getElementById('todo-search');
        if (todoSearch) {
            todoSearch.addEventListener('input', (e) => {
                this.filterTodos(e.target.value);
            });
        }
    }

    /**
     * Setup manual generation controls and event listeners
     */
    setupManualGenerationControls() {
        // Manual generation button
        const manualGenerateBtn = document.getElementById('manual-generate-todos');
        if (manualGenerateBtn) {
            manualGenerateBtn.addEventListener('click', () => {
                this.handleManualGeneration();
            });
        }

        // Terminal selector
        const terminalSelector = document.getElementById('manual-terminal-selector');
        if (terminalSelector) {
            terminalSelector.addEventListener('click', () => {
                this.toggleManualTerminalSelector();
            });
        }

        // Mode selector
        const modeSelector = document.getElementById('manual-mode-selector');
        if (modeSelector) {
            modeSelector.addEventListener('click', () => {
                this.toggleManualModeSelector();
            });
        }

        // Custom prompt save
        const saveCustomPromptBtn = document.getElementById('save-custom-prompt');
        if (saveCustomPromptBtn) {
            saveCustomPromptBtn.addEventListener('click', () => {
                this.saveCustomPrompt();
            });
        }

        // Update UI with initial values
        this.updateManualGenerationUI();
    }

    /**
     * Switch sidebar view between action log and todos
     * @param {string} view - View to switch to ('action-log' or 'todos')
     */
    async switchSidebarView(view) {
        const actionLogSection = document.getElementById('action-log-section');
        const todosSection = document.getElementById('todos-section');
        const actionLogBtn = document.getElementById('action-log-btn');
        const todosBtn = document.getElementById('todos-btn');

        if (!actionLogSection || !todosSection) return;

        // Update visibility
        if (view === 'todos') {
            actionLogSection.style.display = 'none';
            todosSection.style.display = 'block';
            actionLogBtn?.classList.remove('active');
            todosBtn?.classList.add('active');
            this.currentView = 'todos';
            
            // Load fresh todos when switching to view
            await this.loadTodos();
        } else {
            actionLogSection.style.display = 'block';
            todosSection.style.display = 'none';
            actionLogBtn?.classList.add('active');
            todosBtn?.classList.remove('active');
            this.currentView = 'action-log';
        }

        // Save view preference to backend
        await this.saveSidebarView(view);
        this.logAction(`Switched to ${view} view`, 'info');
    }

    /**
     * Load todos from backend
     */
    async loadTodos() {
        try {
            const response = await this.apiClient.getTodos();
            this.todos = response.todos || [];
            this.renderTodos();
        } catch (error) {
            this.logAction(`Failed to load todos: ${error.message}`, 'error');
            this.todos = [];
            this.renderTodos();
        }
    }

    /**
     * Render todos to the DOM
     */
    renderTodos() {
        const todoList = document.getElementById('todo-list');
        if (!todoList) return;

        todoList.innerHTML = '';

        if (this.todos.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-state';
            emptyMessage.textContent = 'No todos available. Generate some based on terminal activity!';
            todoList.appendChild(emptyMessage);
            return;
        }

        // Group todos by completion status
        const incompleteTodos = this.todos.filter(todo => !todo.completed);
        const completedTodos = this.todos.filter(todo => todo.completed);

        // Render incomplete todos first
        incompleteTodos.forEach(todo => {
            const todoElement = this.createTodoElement(todo);
            todoList.appendChild(todoElement);
        });

        // Add separator if there are both complete and incomplete todos
        if (incompleteTodos.length > 0 && completedTodos.length > 0) {
            const separator = document.createElement('div');
            separator.className = 'todo-separator';
            separator.textContent = 'Completed';
            todoList.appendChild(separator);
        }

        // Render completed todos
        completedTodos.forEach(todo => {
            const todoElement = this.createTodoElement(todo);
            todoList.appendChild(todoElement);
        });

        // Update todo count
        this.updateTodoCount();
    }

    /**
     * Create a todo element for display
     * @param {Object} todo - Todo object
     * @returns {HTMLElement} - DOM element for the todo
     */
    createTodoElement(todo) {
        const todoItem = document.createElement('div');
        todoItem.className = `todo-item ${todo.completed ? 'completed' : ''}`;
        todoItem.dataset.todoId = todo.id;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = todo.completed;
        checkbox.addEventListener('change', () => {
            this.toggleTodo(todo.id);
        });

        const todoText = document.createElement('span');
        todoText.className = 'todo-text';
        todoText.textContent = todo.text;

        const metadata = document.createElement('div');
        metadata.className = 'todo-metadata';
        
        if (todo.terminal_number) {
            const terminalInfo = document.createElement('span');
            terminalInfo.className = 'todo-terminal';
            terminalInfo.textContent = `Terminal ${todo.terminal_number}`;
            metadata.appendChild(terminalInfo);
        }

        if (todo.created_at) {
            const timeInfo = document.createElement('span');
            timeInfo.className = 'todo-time';
            timeInfo.textContent = new Date(todo.created_at).toLocaleString();
            metadata.appendChild(timeInfo);
        }

        todoItem.appendChild(checkbox);
        todoItem.appendChild(todoText);
        todoItem.appendChild(metadata);

        return todoItem;
    }

    /**
     * Toggle todo completion status
     * @param {number} todoId - ID of the todo to toggle
     */
    async toggleTodo(todoId) {
        try {
            const todo = this.todos.find(t => t.id === todoId);
            if (!todo) return;

            const newStatus = !todo.completed;
            await this.apiClient.updateTodo(todoId, { completed: newStatus });
            
            // Update local state
            todo.completed = newStatus;
            this.renderTodos();
            
            const action = newStatus ? 'completed' : 'marked as incomplete';
            this.logAction(`Todo ${action}: "${todo.text}"`, 'info');
        } catch (error) {
            this.logAction(`Failed to toggle todo: ${error.message}`, 'error');
        }
    }

    /**
     * Clear completed todos
     */
    async clearCompletedTodos() {
        try {
            const completedCount = this.todos.filter(todo => todo.completed).length;
            if (completedCount === 0) {
                this.logAction('No completed todos to clear', 'info');
                return;
            }

            await this.apiClient.clearCompletedTodos();
            await this.loadTodos(); // Refresh the list
            this.logAction(`Cleared ${completedCount} completed todos`, 'info');
        } catch (error) {
            this.logAction(`Failed to clear completed todos: ${error.message}`, 'error');
        }
    }

    /**
     * Clear all todos with confirmation
     */
    async clearAllTodos() {
        const todoCount = this.todos.length;
        if (todoCount === 0) {
            this.logAction('No todos to clear', 'info');
            return;
        }

        const confirmed = confirm(`Are you sure you want to clear all ${todoCount} todos? This cannot be undone.`);
        if (!confirmed) return;

        try {
            await this.apiClient.clearAllTodos();
            this.todos = [];
            this.renderTodos();
            this.logAction(`Cleared all ${todoCount} todos`, 'info');
        } catch (error) {
            this.logAction(`Failed to clear all todos: ${error.message}`, 'error');
        }
    }

    /**
     * Refresh todos display if in todo view
     */
    async refreshTodos() {
        if (this.currentView === 'todos') {
            await this.loadTodos();
            this.logAction('Todos refreshed', 'info');
        }
    }

    /**
     * Filter todos based on search term
     * @param {string} searchTerm - Search term to filter by
     */
    filterTodos(searchTerm) {
        const todoItems = document.querySelectorAll('.todo-item');
        const term = searchTerm.toLowerCase();

        todoItems.forEach(item => {
            const text = item.querySelector('.todo-text').textContent.toLowerCase();
            const terminal = item.querySelector('.todo-terminal')?.textContent.toLowerCase() || '';
            
            const matches = text.includes(term) || terminal.includes(term);
            item.style.display = matches ? 'flex' : 'none';
        });
    }

    /**
     * Handle manual todo generation
     */
    async handleManualGeneration() {
        if (this.manualGeneration.isLoading) return;

        try {
            this.setManualGenerationLoading(true);

            if (this.manualGeneration.selectedTerminal === 'all') {
                await this.generateTodosForAllTerminals(this.manualGeneration.selectedMode);
            } else {
                const terminalId = this.manualGeneration.selectedTerminal === 'current' 
                    ? this.getCurrentTerminalId() 
                    : this.manualGeneration.selectedTerminal;
                
                await this.generateTodosForTerminal(terminalId, this.manualGeneration.selectedMode);
            }
        } finally {
            this.setManualGenerationLoading(false);
        }
    }

    /**
     * Generate todos for all terminals
     * @param {string} mode - Generation mode
     */
    async generateTodosForAllTerminals(mode) {
        const terminals = this.getAvailableTerminals();
        
        for (const terminal of terminals) {
            try {
                await this.generateTodosForTerminal(terminal.id, mode);
            } catch (error) {
                this.logAction(`Failed to generate todos for Terminal ${terminal.id}: ${error.message}`, 'error');
            }
        }
        
        this.logAction(`Manual todo generation completed for all terminals (${mode} mode)`, 'success');
    }

    /**
     * Generate todos for specific terminal
     * @param {string} terminalId - Terminal ID
     * @param {string} mode - Generation mode
     */
    async generateTodosForTerminal(terminalId, mode) {
        const terminalOutput = this.getCleanTerminalOutput(terminalId);
        if (!terminalOutput) {
            this.logAction(`No output available for Terminal ${terminalId}`, 'warning');
            return;
        }

        await this.generateTodosViaBackendWithMode(terminalId, terminalOutput, mode);
        const terminalNumber = this.getTerminalNumberFromSession(terminalId);
        this.logAction(`Manual todo generation completed for Terminal ${terminalNumber} (${mode} mode)`, 'success');
    }

    /**
     * Set manual generation loading state
     * @param {boolean} isLoading - Loading state
     */
    setManualGenerationLoading(isLoading) {
        this.manualGeneration.isLoading = isLoading;
        
        const generateBtn = document.getElementById('manual-generate-todos');
        if (generateBtn) {
            generateBtn.disabled = isLoading;
            generateBtn.textContent = isLoading ? 'Generating...' : 'Generate Todos';
        }
        
        const terminalSelector = document.getElementById('manual-terminal-selector');
        const modeSelector = document.getElementById('manual-mode-selector');
        
        if (terminalSelector) terminalSelector.style.pointerEvents = isLoading ? 'none' : 'auto';
        if (modeSelector) modeSelector.style.pointerEvents = isLoading ? 'none' : 'auto';
    }

    /**
     * Generate todos via backend with specific mode
     * @param {string} terminalId - Terminal ID
     * @param {string} terminalOutput - Terminal output
     * @param {string} mode - Generation mode
     */
    async generateTodosViaBackendWithMode(terminalId, terminalOutput, mode) {
        try {
            // Create backend session if needed
            await this.createBackendSession(terminalId);
            
            const sessionId = this.sessionMapping.get(terminalId);
            if (!sessionId) {
                throw new Error('No session available for terminal');
            }

            let prompt = '';
            switch (mode) {
                case 'incremental':
                    prompt = 'Generate incremental todos based on recent terminal activity';
                    break;
                case 'comprehensive':
                    prompt = 'Generate a comprehensive todo list based on all terminal output';
                    break;
                case 'custom':
                    prompt = this.manualGeneration.customPrompt || 'Generate todos based on terminal activity';
                    break;
                default:
                    prompt = 'Generate todos based on terminal activity';
            }

            const response = await this.apiClient.generateTodos({
                session_id: sessionId,
                terminal_output: terminalOutput,
                custom_prompt: prompt
            });

            if (response.success) {
                await this.loadTodos(); // Refresh todo list
            }
        } catch (error) {
            this.logAction(`Failed to generate todos: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Create backend session for terminal
     * @param {string} terminalId - Terminal ID
     */
    async createBackendSession(terminalId) {
        if (this.sessionMapping.has(terminalId)) {
            return this.sessionMapping.get(terminalId);
        }

        try {
            const response = await this.apiClient.createSession({
                terminal_id: terminalId,
                session_type: 'manual_generation'
            });

            if (response.session_id) {
                this.sessionMapping.set(terminalId, response.session_id);
                return response.session_id;
            }
        } catch (error) {
            this.logAction(`Failed to create session for Terminal ${terminalId}: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Toggle manual terminal selector dropdown
     */
    toggleManualTerminalSelector() {
        const dropdown = document.getElementById('manual-terminal-selector-dropdown');
        if (dropdown) {
            dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
            if (dropdown.style.display === 'block') {
                this.updateManualTerminalDropdown();
            }
        }
    }

    /**
     * Toggle manual mode selector dropdown
     */
    toggleManualModeSelector() {
        const dropdown = document.getElementById('manual-mode-dropdown');
        if (dropdown) {
            dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
            if (dropdown.style.display === 'block') {
                this.updateManualModeDropdown();
            }
        }
    }

    /**
     * Update manual terminal dropdown with available terminals
     */
    updateManualTerminalDropdown() {
        const dropdown = document.getElementById('manual-terminal-selector-dropdown');
        if (!dropdown) return;

        dropdown.innerHTML = '';

        // Add current terminal option
        const currentItem = this.createDropdownItem('current', 'Current Terminal');
        dropdown.appendChild(currentItem);

        // Add all terminals option
        const allItem = this.createDropdownItem('all', 'All Terminals');
        dropdown.appendChild(allItem);

        // Add individual terminals
        const terminals = this.getAvailableTerminals();
        terminals.forEach(terminal => {
            const item = this.createDropdownItem(terminal.id, `Terminal ${terminal.number}`);
            dropdown.appendChild(item);
        });
    }

    /**
     * Update manual mode dropdown
     */
    updateManualModeDropdown() {
        const dropdown = document.getElementById('manual-mode-dropdown');
        if (!dropdown) return;

        const modes = [
            { value: 'incremental', label: 'Incremental' },
            { value: 'comprehensive', label: 'Comprehensive' },
            { value: 'custom', label: 'Custom Prompt' }
        ];

        dropdown.innerHTML = '';
        modes.forEach(mode => {
            const item = this.createDropdownItem(mode.value, mode.label);
            dropdown.appendChild(item);
        });
    }

    /**
     * Create dropdown item element
     * @param {string} value - Item value
     * @param {string} label - Item label
     * @returns {HTMLElement} - Dropdown item element
     */
    createDropdownItem(value, label) {
        const item = document.createElement('div');
        item.className = 'dropdown-item';
        item.textContent = label;
        item.addEventListener('click', () => {
            if (value === 'incremental' || value === 'comprehensive' || value === 'custom') {
                this.selectManualMode(item);
            } else {
                this.selectManualTerminal(item);
            }
        });
        return item;
    }

    /**
     * Select manual terminal
     * @param {HTMLElement} item - Selected dropdown item
     */
    selectManualTerminal(item) {
        // Implementation depends on context methods
        // This would need to be implemented based on available terminal data
    }

    /**
     * Select manual mode
     * @param {HTMLElement} item - Selected dropdown item
     */
    selectManualMode(item) {
        // Implementation depends on context methods
        // This would need to be implemented based on mode selection logic
    }

    /**
     * Update manual generation UI
     */
    updateManualGenerationUI() {
        // Update selector displays
        const terminalSelector = document.getElementById('manual-terminal-selected');
        const modeSelector = document.getElementById('manual-mode-selected');
        
        if (terminalSelector) {
            terminalSelector.textContent = this.getTerminalDisplayName(this.manualGeneration.selectedTerminal);
        }
        
        if (modeSelector) {
            modeSelector.textContent = this.getModeDisplayName(this.manualGeneration.selectedMode);
        }

        // Show/hide custom prompt textarea
        const customPromptContainer = document.getElementById('custom-prompt-container');
        if (customPromptContainer) {
            customPromptContainer.style.display = 
                this.manualGeneration.selectedMode === 'custom' ? 'block' : 'none';
        }
    }

    /**
     * Save custom prompt
     */
    async saveCustomPrompt() {
        const textarea = document.getElementById('custom-prompt-textarea');
        if (!textarea) return;

        this.manualGeneration.customPrompt = textarea.value;
        
        try {
            await this.apiClient.saveSetting('customTodoPrompt', textarea.value);
            this.logAction('Custom prompt saved', 'success');
        } catch (error) {
            this.logAction(`Failed to save custom prompt: ${error.message}`, 'error');
        }
    }

    /**
     * Load custom prompt
     */
    async loadCustomPrompt() {
        try {
            const prompt = await this.apiClient.getSetting('customTodoPrompt');
            if (prompt) {
                this.manualGeneration.customPrompt = prompt;
                const textarea = document.getElementById('custom-prompt-textarea');
                if (textarea) {
                    textarea.value = prompt;
                }
            }
        } catch (error) {
            this.logAction(`Failed to load custom prompt: ${error.message}`, 'error');
        }
    }

    /**
     * Helper methods that would need to be implemented based on context
     */
    getCurrentTerminalId() {
        // Implementation depends on terminal context
        return 'current';
    }

    getAvailableTerminals() {
        // Implementation depends on terminal context
        return [];
    }

    getCleanTerminalOutput(terminalId) {
        // Implementation depends on terminal context
        return '';
    }

    getTerminalNumberFromSession(terminalId) {
        // Implementation depends on session mapping
        return terminalId;
    }

    getTerminalDisplayName(value) {
        if (value === 'current') return 'Current Terminal';
        if (value === 'all') return 'All Terminals';
        return `Terminal ${value}`;
    }

    getModeDisplayName(value) {
        const modes = {
            incremental: 'Incremental',
            comprehensive: 'Comprehensive',
            custom: 'Custom Prompt'
        };
        return modes[value] || value;
    }

    async getSavedSidebarView() {
        try {
            return await this.apiClient.getSetting('sidebarView');
        } catch (error) {
            return null;
        }
    }

    async saveSidebarView(view) {
        try {
            await this.apiClient.saveSetting('sidebarView', view);
        } catch (error) {
            this.logAction(`Failed to save sidebar view: ${error.message}`, 'error');
        }
    }

    updateTodoCount() {
        const total = this.todos.length;
        const completed = this.todos.filter(todo => todo.completed).length;
        const incomplete = total - completed;

        const countElement = document.getElementById('todo-count');
        if (countElement) {
            countElement.textContent = `${incomplete} active, ${completed} completed`;
        }
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        this.todos = [];
        this.sessionMapping.clear();
        this.manualGeneration = {
            selectedTerminal: 'current',
            selectedMode: 'incremental',
            customPrompt: '',
            isLoading: false
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TodoManager;
} else if (typeof window !== 'undefined') {
    window.TodoManager = TodoManager;
}