#!/bin/bash

# Get the absolute path to the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Create logs directory if it doesn't exist
mkdir -p "$PROJECT_DIR/logs"

# Create a temporary crontab file
TEMP_CRONTAB=$(mktemp)

# Export current crontab
crontab -l > "$TEMP_CRONTAB" 2>/dev/null || echo "# Reelty cron jobs" > "$TEMP_CRONTAB"

# Check if the expired subscriptions job already exists
if ! grep -q "checkExpiredSubscriptions.ts" "$TEMP_CRONTAB"; then
  # Add the job to run daily at midnight
  echo "# Check for expired subscriptions daily at midnight" >> "$TEMP_CRONTAB"
  echo "0 0 * * * cd $PROJECT_DIR && npx ts-node scripts/checkExpiredSubscriptions.ts >> $PROJECT_DIR/logs/cron-expired-subscriptions.log 2>&1" >> "$TEMP_CRONTAB"
  
  echo "Cron job for checking expired subscriptions has been added."
else
  echo "Cron job for checking expired subscriptions already exists."
fi

# Check if the validation job already exists
if ! grep -q "validateUserData.ts" "$TEMP_CRONTAB"; then
  # Add the job to run weekly on Sunday at 1 AM
  echo "# Validate user data consistency weekly on Sunday at 1 AM" >> "$TEMP_CRONTAB"
  echo "0 1 * * 0 cd $PROJECT_DIR && npx ts-node scripts/validateUserData.ts >> $PROJECT_DIR/logs/cron-validate-user-data.log 2>&1" >> "$TEMP_CRONTAB"
  
  echo "Cron job for validating user data has been added."
else
  echo "Cron job for validating user data already exists."
fi

# Install the new crontab
crontab "$TEMP_CRONTAB"

# Clean up
rm "$TEMP_CRONTAB"

echo "Cron setup complete." 