#!/bin/bash

# Activate virtual environment
source venv/bin/activate

# Start Django development server on port 8001
echo "Starting Django backend on http://127.0.0.1:8001"
python manage.py runserver 127.0.0.1:8001