# Authentication and Webhook Troubleshooting Guide

This document provides solutions for common authentication and webhook issues in the Reelty backend.

## Authentication Errors

### "Invalid or missing session" Error

This error occurs when a user tries to access a protected route but doesn't have a valid session token.

**Error Example:**

```
error: [Auth] Authentication error {"error":"Invalid or missing session"...}
```

**Possible Causes:**

1. The user is not logged in
2. The session token has expired
3. The token is invalid or malformed
4. The user was deleted but the frontend still has an old token

**Solutions:**

1. Ensure the user completes the sign-up process
2. Redirect to login if the session is invalid
3. Clear local storage/cookies and re-authenticate
4. Check that the Clerk frontend and backend keys match

## Clerk Webhook Verification Errors

### "No matching signature found" Error

This error occurs when the webhook signature from Clerk doesn't match what's expected.

**Error Example:**

```
error: [Clerk Webhook] Verification failed {"error":"No matching signature found"...}
```

**Possible Causes:**

1. The webhook secret in your environment doesn't match the one in Clerk dashboard
2. The webhook payload was modified during transmission
3. The request headers were modified by a proxy or load balancer
4. The raw body wasn't properly captured for verification

**Solutions:**

### 1. Verify the Webhook Secret

Run the verification script to check if your webhook secret is valid:

```bash
node scripts/verify-webhook-secret.js
```

### 2. Update the Webhook Secret

1. Go to the Clerk Dashboard
2. Navigate to Webhooks
3. Select your webhook endpoint
4. Click "View signing secret"
5. Copy the secret
6. Update your environment variable:

```
CLERK_WEBHOOK_SECRET=your_secret_from_clerk_dashboard
```

### 3. Check Your Webhook URL

Ensure your webhook URL in the Clerk dashboard is correct:

- Production: `https://reelty-backend-production.up.railway.app/webhooks/clerk`
- Development: `http://localhost:3001/webhooks/clerk`

### 4. Verify Raw Body Parsing

The raw body must be captured for webhook verification. Our Express setup includes:

```javascript
app.use(
  express.json({
    verify: (req, res, buf) => {
      // Store the raw body for webhook verification
      (req as any).rawBody = buf.toString();
    }
  })
);
```

### 5. Check for Proxies or Load Balancers

If you're using a proxy or load balancer, ensure it's not modifying the request headers or body.

## Testing Webhooks Locally

To test webhooks locally:

1. Install the Clerk CLI:

```bash
npm install -g @clerk/clerk-sdk-node
```

2. Forward webhooks to your local server:

```bash
npx clerk webhook:forward --key your_clerk_secret_key http://localhost:3001/webhooks/clerk
```

## Additional Resources

- [Clerk Webhook Documentation](https://clerk.com/docs/integration/webhooks)
- [Svix Webhook Library](https://github.com/svix/svix-webhooks)
- [Express.js Body Parsing](https://expressjs.com/en/api.html#express.json)
