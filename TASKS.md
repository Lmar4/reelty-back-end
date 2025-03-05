# Backend Tasks

## Implement VideoDownload Model

The frontend has been updated to track video downloads, but the backend needs to be updated to support this feature.

### Steps:

1. Fix the migration for the VideoDownload model:

   - The current migration is failing because of a type mismatch between the `jobId` in the `VideoDownload` model and the `id` in the `VideoJob` model.
   - The `jobId` should be of type `UUID` to match the `id` in the `VideoJob` model.
   - **IMPORTANT**: The migration needs to be fixed without data loss. The current approach of running `npx prisma migrate dev` would reset the database, which is not acceptable in production.

2. Recommended approach for fixing the migration:

   - Create a new migration file manually in the migrations directory with a new timestamp
   - The migration should create the VideoDownload table with the correct UUID type for jobId
   - Run the migration directly on the database using `npx prisma migrate deploy` which applies pending migrations without resetting the database

3. Once the migration is successfully applied:

   - Update the Prisma client: `npx prisma generate`
   - Update the code in `src/routes/videos.ts` to use the VideoDownload model for tracking downloads and enforcing limits

4. Current workaround:
   - The code in `src/routes/videos.ts` has been updated to log download attempts without trying to use the VideoDownload model
   - This allows the application to continue functioning while the migration issue is being resolved
   - Once the migration is properly applied, the code should be updated to implement the full download tracking functionality

### Current Status:

- The frontend is tracking downloads and limiting free users to one download
- The backend route is implemented but is not actually tracking downloads in the database
- The migration for the VideoDownload model is failing due to a type mismatch

### Expected Behavior:

- The backend should track video downloads in the database
- The backend should enforce download limits based on the user's subscription tier
- The frontend should display the user's download count and limit
