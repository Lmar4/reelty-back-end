I'll organize all the endpoints by their route groups. Here's a comprehensive list:

### Admin Routes (`/api/admin`)

#### Analytics

- `GET /api/admin/analytics/videos` - Get video analytics
- `GET /api/admin/analytics/revenue` - Get revenue analytics
- `GET /api/admin/analytics/credits` - Get credit analytics
- `GET /api/admin/analytics/activity` - Get recent activities

#### Assets

- `GET /api/admin/assets/assets` - Get all assets
- `POST /api/admin/assets/assets` - Create new asset
- `PATCH /api/admin/assets/assets/:assetId` - Update asset
- `DELETE /api/admin/assets/assets/:assetId` - Delete asset

#### Bulk Discounts

- `POST /api/admin/bulk-discounts` - Create bulk discount
- `POST /api/admin/bulk-discounts/apply` - Apply bulk discount to user
- `POST /api/admin/bulk-discounts/:id/deactivate` - Deactivate bulk discount

#### Agency Management

- `POST /api/admin/agencies` - Create agency
- `POST /api/admin/agencies/users` - Add user to agency

#### Stats

- `GET /api/admin/stats/users` - Get user statistics

#### Subscription Tiers

- `GET /api/admin/subscription-tiers` - Get all subscription tiers

#### Templates

- `GET /api/admin/templates` - Get all templates
- `POST /api/admin/templates` - Create template
- `PUT /api/admin/templates/reorder` - Reorder templates

### User Routes (`/api/users`)

- `POST /api/users` - Create user (Clerk webhook)
- `GET /api/users/:userId` - Get user by ID
- `DELETE /api/users/:userId` - Delete user and associated data

### Listings Routes (`/api/listings`)

- `GET /api/listings` - Get all listings
- `GET /api/listings/:listingId` - Get specific listing
- `POST /api/listings` - Create new listing
- `POST /api/listings/:listingId/photos` - Upload photo to listing

### Job Routes (`/api/jobs`)

- `GET /api/jobs` - Get all jobs
- `POST /api/jobs` - Create new job
- `GET /api/jobs/:jobId` - Get specific job
- `PATCH /api/jobs/:jobId` - Update job
- `DELETE /api/jobs/:jobId` - Delete job
- `POST /api/jobs/:jobId/regenerate` - Regenerate job

### Queue Routes (`/api/queue`)

- `POST /api/queue/enqueue` - Enqueue a video job
- `GET /api/queue/status` - Get queue status

### Subscription Routes (`/api/subscription`)

- `GET /api/subscription/tiers` - Get all subscription tiers
- `PATCH /api/subscription/tier` - Update user's subscription tier
- `POST /api/subscription/checkout` - Initiate checkout process
- `POST /api/subscription/update` - Update subscription from Stripe
- `POST /api/subscription/cancel` - Cancel subscription
- `GET /api/subscription/current` - Get current subscription

### Credits Routes (`/api/credits`)

- `GET /api/credits/balance` - Get credit balance
- `POST /api/credits/check` - Check credits
- `POST /api/credits/deduct` - Deduct credits
- `GET /api/credits/history/:userId` - Get credit history
- `POST /api/credits/purchase` - Purchase credits

### Payment Routes (`/api/payment`)

- `POST /api/payment/setup` - Setup payment intent
- `GET /api/payment/methods` - List payment methods
- `DELETE /api/payment/method` - Delete payment method
- `POST /api/payment/method/default` - Update default payment method

### Storage Routes (`/api/storage`)

- `POST /api/storage/upload` - Get upload URL
- `GET /api/storage/download/:propertyId/:fileKey` - Get download URL
- `DELETE /api/storage/file/:propertyId/:fileKey` - Delete file

### Auth Routes (`/api/auth`)

- `GET /api/auth/token` - Get auth token

All these routes are protected with appropriate middleware (authentication, validation, etc.) as defined in their respective route files.
