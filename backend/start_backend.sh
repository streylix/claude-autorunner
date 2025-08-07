#!/bin/bash

# Activate virtual environment
source venv/bin/activate

# Start Django development server (WSGI)
echo "Starting WSGI backend on http://127.0.0.1:8001"
python manage.py runserver 127.0.0.1:8001