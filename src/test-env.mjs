// Test-only OAuth fixtures. Production uses environment variables for Google OAuth.
process.env.GEMINI_OAUTH_CLIENT_ID ||= 'test-gemini-client';
process.env.GEMINI_OAUTH_CLIENT_SECRET ||= 'test-gemini-secret';
