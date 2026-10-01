# Service guidelines

- Use the shared HTTP client for every outbound call.
- Keep database migrations reversible and reviewed.
- Write a test for each bug fix before the fix itself.
- Never log request bodies; they can hold personal data.
