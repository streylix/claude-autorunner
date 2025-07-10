import os
import json
import re
from openai import OpenAI
from django.conf import settings
from .models import TodoItem, TodoGeneration


class TodoGenerationService:
    def __init__(self):
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable is not set")
        
        # Initialize OpenAI client with explicit parameters only
        try:
            self.client = OpenAI(api_key=api_key)
        except TypeError as e:
            # If there's a proxy-related error, try with a custom http client
            import httpx
            http_client = httpx.Client()
            self.client = OpenAI(api_key=api_key, http_client=http_client)
    
    def extract_terminal_output_before_prompt(self, terminal_output):
        """
        Extract the last 1000 characters before a '╭' character
        This typically indicates the start of a Claude Code prompt
        """
        # Find the last occurrence of '╭' 
        last_prompt_start = terminal_output.rfind('╭')
        
        if last_prompt_start == -1:
            # No prompt found, use the last 1000 characters
            return terminal_output[-1000:] if len(terminal_output) > 1000 else terminal_output
        
        # Extract content before the prompt
        content_before_prompt = terminal_output[:last_prompt_start]
        
        # Get the last 1000 characters before the prompt
        if len(content_before_prompt) > 1000:
            return content_before_prompt[-1000:]
        
        return content_before_prompt
    
    def generate_todos_from_output(self, terminal_output, terminal_session, terminal_id=1, mode='verify', custom_prompt=''):
        """
        Generate todo items from terminal output using GPT-4o-mini
        """
        try:
            # Extract relevant content
            relevant_output = self.extract_terminal_output_before_prompt(terminal_output)
            
            if not relevant_output.strip():
                return {"error": "No relevant terminal output found"}
            
            # Create generation record
            generation = TodoGeneration.objects.create(
                terminal_session=terminal_session,
                terminal_output=relevant_output,
                status='processing'
            )
            
            # Prepare prompt based on mode
            if mode == 'verify':
                system_prompt = """You are an assistant that creates concise, actionable todos from terminal output.

IMPORTANT: Always generate at least 1 todo item. Never return an empty array.

Analyze the terminal output to understand what specific changes were made, what files were modified, what commands were run, and what functionality was added or fixed.

Generate 1-3 specific, high-value todos based on the ACTUAL changes shown in the terminal output:
- Test the specific functionality that was just implemented or modified
- Run specific commands that are relevant to the changes made
- Fix specific issues that were identified in the output
- Verify that specific features work correctly after changes
- Document specific changes that were made

Return ONLY a JSON array. Each todo should have:
- "title": Brief, actionable description of what to do (max 50 chars)
- "description": Specific details about what was changed and what to test/verify (max 100 chars)  
- "priority": "high", "medium", or "low"

Example:
[
  {
    "title": "Test user authentication flow",
    "description": "Verify login works after fixing auth middleware bug in user.js:45",
    "priority": "high"
  }
]

Base todos on the SPECIFIC changes shown in the terminal output. If you see file modifications, command executions, or error fixes, create todos that relate directly to testing or verifying those specific changes."""
            
            elif mode == 'explain':
                system_prompt = """You are an assistant that creates explanatory todos from terminal output.

IMPORTANT: Always generate at least 1 todo item. Never return an empty array.

Analyze the terminal output and create todos that briefly explain what happened in the terminal session.

Generate 1-3 todos that explain:
- What commands were executed and their purpose
- What files were modified and why
- What functionality was implemented or fixed
- What the output indicates about the system state
- What the user accomplished in this session

Return ONLY a JSON array. Each todo should have:
- "title": Brief description of what happened (max 50 chars)
- "description": Explanation of what was done and why (max 100 chars)
- "priority": "medium" (explanatory todos are typically medium priority)

Example:
[
  {
    "title": "Fixed authentication middleware bug",
    "description": "Updated user.js:45 to handle null tokens properly in auth flow",
    "priority": "medium"
  }
]

Focus on explaining the ACTUAL activities shown in the terminal output."""
            
            elif mode == 'custom':
                system_prompt = f"""You are an assistant that creates todos from terminal output based on custom instructions.

IMPORTANT: Always generate at least 1 todo item. Never return an empty array.

Custom instructions: {custom_prompt}

Analyze the terminal output and create todos following the custom instructions above.

Return ONLY a JSON array. Each todo should have:
- "title": Brief, actionable description (max 50 chars)
- "description": Specific details (max 100 chars)
- "priority": "high", "medium", or "low"

Example:
[
  {{
    "title": "Example todo title",
    "description": "Example todo description based on terminal output",
    "priority": "medium"
  }}
]

Follow the custom instructions while analyzing the terminal output."""
            
            else:
                # Default to verify mode
                system_prompt = """You are an assistant that creates concise, actionable todos from terminal output.

IMPORTANT: Always generate at least 1 todo item. Never return an empty array.

Analyze the terminal output to understand what specific changes were made, what files were modified, what commands were run, and what functionality was added or fixed.

Generate 1-3 specific, high-value todos based on the ACTUAL changes shown in the terminal output:
- Test the specific functionality that was just implemented or modified
- Run specific commands that are relevant to the changes made
- Fix specific issues that were identified in the output
- Verify that specific features work correctly after changes
- Document specific changes that were made

Return ONLY a JSON array. Each todo should have:
- "title": Brief, actionable description of what to do (max 50 chars)
- "description": Specific details about what was changed and what to test/verify (max 100 chars)  
- "priority": "high", "medium", or "low"

Example:
[
  {
    "title": "Test user authentication flow",
    "description": "Verify login works after fixing auth middleware bug in user.js:45",
    "priority": "high"
  }
]

Base todos on the SPECIFIC changes shown in the terminal output. If you see file modifications, command executions, or error fixes, create todos that relate directly to testing or verifying those specific changes."""

            user_prompt = f"""Terminal Output:
{relevant_output}

Generate todo items based on this terminal output. Return only the JSON array."""

            # Call OpenAI API
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.3,
                max_tokens=1000
            )
            
            # Parse response
            response_text = response.choices[0].message.content.strip()
            
            # Extract JSON from response (handle potential markdown formatting)
            json_match = re.search(r'```json\s*(.*?)\s*```', response_text, re.DOTALL)
            if json_match:
                json_text = json_match.group(1)
            else:
                json_text = response_text
            
            # Parse JSON
            try:
                todos_data = json.loads(json_text)
            except json.JSONDecodeError:
                # Try to find JSON array in the text
                json_start = json_text.find('[')
                json_end = json_text.rfind(']') + 1
                if json_start != -1 and json_end > json_start:
                    todos_data = json.loads(json_text[json_start:json_end])
                else:
                    raise ValueError("Could not parse JSON from response")
            
            if not isinstance(todos_data, list):
                raise ValueError("Response is not a JSON array")
            
            # Create TodoItem objects
            created_todos = []
            for todo_data in todos_data:
                if not isinstance(todo_data, dict):
                    continue
                
                title = todo_data.get('title', '').strip()
                if not title:
                    continue
                
                todo = TodoItem.objects.create(
                    terminal_session=terminal_session,
                    terminal_id=terminal_id,
                    title=title[:500],  # Truncate if too long
                    description=todo_data.get('description', '')[:1000],  # Truncate if too long
                    priority=todo_data.get('priority', 'medium'),
                    source_output=relevant_output,
                    auto_generated=True
                )
                created_todos.append(todo)
            
            # Ensure at least one todo is created
            # if not created_todos:
            #     fallback_todo = TodoItem.objects.create(
            #         terminal_session=terminal_session,
            #         title="Review recent terminal activity",
            #         description="Check the recent terminal output and verify any changes made",
            #         priority="medium",
            #         source_output=relevant_output,
            #         auto_generated=True
            #     )
            #     created_todos.append(fallback_todo)
            
            # Update generation record
            generation.status = 'completed'
            generation.todos_count = len(created_todos)
            generation.save()
            
            return {
                "success": True,
                "todos_created": len(created_todos),
                "generation_id": str(generation.id),
                "todos": [
                    {
                        "id": str(todo.id),
                        "title": todo.title,
                        "description": todo.description,
                        "priority": todo.priority
                    }
                    for todo in created_todos
                ]
            }
            
        except Exception as e:
            # Update generation record with error
            if 'generation' in locals():
                generation.status = 'failed'
                generation.error_message = str(e)
                generation.save()
            
            return {"error": f"Failed to generate todos: {str(e)}"}
    
    def is_api_key_configured(self):
        """Check if OpenAI API key is properly configured"""
        api_key = os.getenv('OPENAI_API_KEY')
        return api_key is not None and api_key.strip() != ''