# Terminal models removed to fix terminal state storage issues
# All terminal state is now handled in-memory only
# This eliminates the problem of 973+ orphaned terminal sessions causing API spam

from django.db import models
import uuid

# NOTE: TerminalSession, TerminalCommand, and ApplicationStatistics models have been 
# intentionally removed to eliminate problematic terminal state persistence.
# Terminals now operate in a stateless manner without database storage.
