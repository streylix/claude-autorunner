#!/usr/bin/env python3
import subprocess
import re
import json

# Run ccusage and capture output exactly like Django does
result = subprocess.run(
    ['npx', 'ccusage'],
    capture_output=True,
    text=True,
    timeout=30,
    cwd='/Users/ethan/claude code bot/backend'  # Same as Django
)

if result.returncode != 0:
    print("Error:", result.stderr)
    exit(1)

raw_output = result.stdout
print(f"Raw output length: {len(raw_output)}")

# Clean ANSI codes exactly like Django
clean_output = raw_output
clean_output = re.sub(r'\x1b\[[0-9;]*m', '', clean_output)
clean_output = re.sub(r'\x1b\[[0-9;]*[mGKHJ]', '', clean_output)
clean_output = re.sub(r'\x1b\[[0-9]+[ABCD]', '', clean_output)
clean_output = re.sub(r'\x1b\[2J', '', clean_output)
clean_output = re.sub(r'\x1b\[3J', '', clean_output)
clean_output = re.sub(r'\x1b\[H', '', clean_output)
clean_output = re.sub(r'\x1b\[2K', '', clean_output)
clean_output = re.sub(r'\x1b\[1A', '', clean_output)
clean_output = re.sub(r'\x1b\[G', '', clean_output)
clean_output = re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', clean_output)
clean_output = re.sub(r'\s+', ' ', clean_output)

print(f"Clean output length: {len(clean_output)}")

# Try parsing
lines = clean_output.split('\n')
print(f"Number of lines: {len(lines)}")

# Look for table rows
table_rows = 0
for i, line in enumerate(lines[:50]):  # First 50 lines
    if '│' in line:
        table_rows += 1
        columns = [col.strip() for col in line.split('│')]
        if len(columns) >= 8:
            date_col = columns[1].strip()
            model_col = columns[2].strip()
            cost_col = columns[8].strip() if len(columns) > 8 else columns[-1].strip()
            
            if date_col or model_col or cost_col:
                print(f"Row {i}: cols={len(columns)}, date='{date_col}', model='{model_col}', cost='{cost_col}'")

print(f"Found {table_rows} table rows in first 50 lines")