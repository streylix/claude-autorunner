#!/bin/bash

# Comprehensive API endpoint test suite
# Tests all timer and control endpoints

# Configuration
API_BASE_URL="http://127.0.0.1:8001/api"
SCRIPTS_DIR="./scripts"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Test results array
declare -a FAILED_TESTS

# Function to print test header
print_header() {
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}   $1${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
}

# Function to print test section
print_section() {
    echo ""
    echo -e "${BLUE}──────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}──────────────────────────────────────────────────────${NC}"
}

# Function to run a test
run_test() {
    local test_name="$1"
    local command="$2"
    local expected_pattern="$3"
    
    TESTS_RUN=$((TESTS_RUN + 1))
    
    echo -n "  Testing $test_name... "
    
    # Run command and capture output
    output=$(eval "$command" 2>&1)
    result=$?
    
    # Check if output matches expected pattern
    if [ $result -eq 0 ] && echo "$output" | grep -q "$expected_pattern"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "    Command: $command"
        echo "    Expected: $expected_pattern"
        echo "    Got: $output"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("$test_name")
        return 1
    fi
}

# Function to test API endpoint directly
test_api() {
    local test_name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local expected_pattern="$5"
    
    TESTS_RUN=$((TESTS_RUN + 1))
    
    echo -n "  Testing $test_name... "
    
    # Build curl command
    if [ "$method" = "GET" ]; then
        cmd="curl -s -X GET '${API_BASE_URL}${endpoint}'"
    elif [ -n "$data" ]; then
        cmd="curl -s -X $method -H 'Content-Type: application/json' -d '$data' '${API_BASE_URL}${endpoint}'"
    else
        cmd="curl -s -X $method '${API_BASE_URL}${endpoint}'"
    fi
    
    # Run command and capture output
    output=$(eval "$cmd" 2>&1)
    result=$?
    
    # Check if output matches expected pattern
    if [ $result -eq 0 ] && echo "$output" | grep -q "$expected_pattern"; then
        echo -e "${GREEN}✓ PASSED${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC}"
        echo "    Endpoint: $method $endpoint"
        echo "    Expected: $expected_pattern"
        echo "    Got: $output"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("$test_name")
        return 1
    fi
}

# Function to check if backend is running
check_backend() {
    echo -n "Checking if backend is running... "
    
    response=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE_URL}/queue/health/" 2>/dev/null)
    
    if [ "$response" = "200" ]; then
        echo -e "${GREEN}✓ Backend is running${NC}"
        return 0
    else
        echo -e "${RED}✗ Backend is not running${NC}"
        echo ""
        echo "Please start the backend first:"
        echo "  cd backend && python manage.py runserver 8001"
        echo ""
        exit 1
    fi
}

# Function to clean up trigger files
cleanup_triggers() {
    rm -f /tmp/claude-code-*-trigger 2>/dev/null
    rm -f /tmp/claude-code-*-status 2>/dev/null
}

# Main test execution
main() {
    print_header "Claude Code Bot API Test Suite"
    echo "Starting comprehensive API endpoint tests..."
    echo ""
    
    # Check if backend is running
    check_backend
    
    # Clean up any existing trigger files
    cleanup_triggers
    
    # Test Timer Control Endpoints
    print_section "Timer Control Endpoints"
    
    test_api "Timer Start" "POST" "/timer/start/" "" '"success": true.*"action": "start"'
    test_api "Timer Pause" "POST" "/timer/pause/" "" '"success": true.*"action": "pause"'
    test_api "Timer Resume" "POST" "/timer/resume/" "" '"success": true.*"action": "resume"'
    test_api "Timer Stop" "POST" "/timer/stop/" "" '"success": true.*"action": "stop"'
    test_api "Timer Reset" "POST" "/timer/reset/" "" '"success": true.*"action": "reset"'
    
    # Test Timer Set with valid values
    test_api "Timer Set (25 min)" "POST" "/timer/set/" '{"hours":0,"minutes":25,"seconds":0}' '"success": true.*"time": "00:25:00"'
    test_api "Timer Set (1h 30m)" "POST" "/timer/set/" '{"hours":1,"minutes":30,"seconds":45}' '"success": true.*"time": "01:30:45"'
    
    # Test Timer Set with invalid values
    test_api "Timer Set (invalid type)" "POST" "/timer/set/" '{"hours":"invalid","minutes":25,"seconds":0}' '"error": "Hours, minutes, and seconds must be integers"'
    test_api "Timer Set (negative)" "POST" "/timer/set/" '{"hours":-1,"minutes":25,"seconds":0}' '"error": "Time values cannot be negative"'
    test_api "Timer Set (out of range)" "POST" "/timer/set/" '{"hours":0,"minutes":75,"seconds":0}' '"error": "Minutes and seconds must be less than 60"'
    
    # Test Timer Status
    test_api "Timer Status" "GET" "/timer/status/" "" '"success": true.*"time"'
    
    # Test Terminal Control Endpoints
    print_section "Terminal Control Endpoints"
    
    test_api "Terminal Switch (1)" "POST" "/terminal/switch/" '{"terminal_id":1}' '"success": true.*"active_terminal": 1'
    test_api "Terminal Switch (2)" "POST" "/terminal/switch/" '{"terminal_id":2}' '"success": true.*"active_terminal": 2'
    test_api "Terminal Switch (3)" "POST" "/terminal/switch/" '{"terminal_id":3}' '"success": true.*"active_terminal": 3'
    test_api "Terminal Switch (4)" "POST" "/terminal/switch/" '{"terminal_id":4}' '"success": true.*"active_terminal": 4'
    
    # Test invalid terminal switches
    test_api "Terminal Switch (0)" "POST" "/terminal/switch/" '{"terminal_id":0}' '"error": "Terminal ID must be between 1 and 4"'
    test_api "Terminal Switch (5)" "POST" "/terminal/switch/" '{"terminal_id":5}' '"error": "Terminal ID must be between 1 and 4"'
    
    # Test Terminal Status
    test_api "Terminal Status" "GET" "/terminal/status/" "" '"success": true.*"terminals"'
    
    # Test Plan Mode Control
    print_section "Plan Mode Control"
    
    test_api "Plan Mode Toggle" "POST" "/planmode/toggle/" "" '"success": true.*"plan_mode_enabled"'
    test_api "Plan Mode Status" "GET" "/planmode/status/" "" '"success": true.*"plan_mode_enabled"'
    
    # Test Auto-Continue Control
    print_section "Auto-Continue Control"
    
    test_api "Auto-Continue Toggle" "POST" "/autocontinue/toggle/" "" '"success": true.*"auto_continue_enabled"'
    
    # Test Injection Control
    print_section "Injection Control"
    
    test_api "Injection Pause" "POST" "/injection/pause/" "" '"success": true.*"injection_paused": true'
    test_api "Injection Resume" "POST" "/injection/resume/" "" '"success": true.*"injection_paused": false'
    test_api "Manual Injection" "POST" "/injection/manual/" "" '"success": true.*"message_injected"'
    
    # Test Queue Status
    print_section "Queue Management"
    
    test_api "Queue Status (all)" "GET" "/queue/status/" "" '"success": true.*"total_messages"'
    test_api "Queue Status (terminal 1)" "GET" "/queue/status/?terminal_id=1" "" '"success": true'
    
    # Test Message Queue Operations (existing endpoints)
    print_section "Message Queue Operations"
    
    test_api "Add Message" "POST" "/queue/add/" '{"content":"test message","terminal_id":"terminal_1"}' '"status": "success"'
    test_api "Clear Queue" "POST" "/queue/clear/" '{"terminal_id":"terminal_1"}' '"status": "success"'
    test_api "Health Check" "GET" "/queue/health/" "" '"status": "healthy"'
    
    # Test Script Functionality
    print_section "Script Integration Tests"
    
    if [ -d "$SCRIPTS_DIR" ]; then
        run_test "Timer Start Script" "$SCRIPTS_DIR/timer-start" "Timer started successfully"
        run_test "Timer Stop Script" "$SCRIPTS_DIR/timer-stop" "Timer stopped successfully"
        run_test "Timer Reset Script" "$SCRIPTS_DIR/timer-reset" "Timer reset successfully"
        run_test "Timer Set Script" "$SCRIPTS_DIR/timer-set 0 10 0" "Timer set to"
        run_test "Timer Status Script" "$SCRIPTS_DIR/timer-status" "Timer Status"
        run_test "Queue Status Script" "$SCRIPTS_DIR/queue-status" "Queue Status"
        run_test "Switch Terminal Script" "$SCRIPTS_DIR/switch-terminal 2" "Switched to Terminal 2"
        run_test "Toggle Plan Mode Script" "$SCRIPTS_DIR/toggle-planmode" "Plan mode"
        run_test "Clear Queue Script" "$SCRIPTS_DIR/clear-queue" "cleared"
    else
        echo -e "${YELLOW}⚠ Skipping script tests (scripts directory not found)${NC}"
    fi
    
    # Test Trigger File Creation
    print_section "Trigger File Verification"
    
    # Test that trigger files are created
    echo -n "  Checking trigger file creation... "
    
    # Send a timer start command
    curl -s -X POST "${API_BASE_URL}/timer/start/" > /dev/null 2>&1
    
    if [ -f "/tmp/claude-code-timer-start-trigger" ]; then
        echo -e "${GREEN}✓ Trigger files are being created${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        echo -e "${RED}✗ Trigger files not being created${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("Trigger file creation")
    fi
    TESTS_RUN=$((TESTS_RUN + 1))
    
    # Clean up trigger files
    cleanup_triggers
    
    # Print Summary
    print_header "Test Summary"
    
    echo ""
    echo "  Total Tests Run: $TESTS_RUN"
    echo -e "  ${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "  ${RED}Failed: $TESTS_FAILED${NC}"
    
    if [ $TESTS_FAILED -gt 0 ]; then
        echo ""
        echo -e "${RED}Failed Tests:${NC}"
        for test in "${FAILED_TESTS[@]}"; do
            echo "  - $test"
        done
    fi
    
    echo ""
    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}   ✓ ALL TESTS PASSED! API is working correctly.${NC}"
        echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
        exit 0
    else
        echo -e "${RED}═══════════════════════════════════════════════════════════════${NC}"
        echo -e "${RED}   ✗ SOME TESTS FAILED. Please review the errors above.${NC}"
        echo -e "${RED}═══════════════════════════════════════════════════════════════${NC}"
        exit 1
    fi
}

# Run main function
main "$@"