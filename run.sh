#!/bin/bash

echo "Are we good"
echo "Enter your input (type 'EOF' on a new line to exit):"

# Continuous input loop
while true; do
    read -p "> " user_input
    # Check if user entered EOF
    if [[ "$user_input" == "EOF" ]]; then
        break
    fi

done

exit 0

