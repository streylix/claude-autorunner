#!/bin/sh
set -e

# Wait-for-db is handled by compose (depends_on: service_healthy), so just
# apply migrations then hand off to the CMD (daphne).
echo "Running database migrations..."
python manage.py migrate --noinput

exec "$@"
