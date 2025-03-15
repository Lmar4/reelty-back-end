import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Create a connection pool using the DATABASE_URL from your .env file
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  // Get a client from the pool
  const client = await pool.connect();

  try {
    const userId = "user_2txphAtnvJC6BDsUE7jSd6UmD4d";

    // First, check if the user exists
    const userResult = await client.query("SELECT * FROM users WHERE id = $1", [
      userId,
    ]);

    if (userResult.rows.length === 0) {
      console.error(`User with ID ${userId} not found`);
      return;
    }

    const user = userResult.rows[0];
    console.log("Current user data:", user);

    // First update the subscription status to ACTIVE
    await client.query(
      `UPDATE users SET "subscriptionStatus" = $1 WHERE id = $2`,
      ["ACTIVE", userId]
    );
    console.log("Subscription status updated to ACTIVE");

    // Then update the role to ADMIN
    await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [
      "ADMIN",
      userId,
    ]);
    console.log("Role updated to ADMIN");

    // Finally update the tier ID
    await client.query(`UPDATE users SET "currentTierId" = $1 WHERE id = $2`, [
      "550e8400-e29b-41d4-a716-446655440003",
      userId,
    ]);
    console.log("Tier updated to REELTY_PRO_PLUS");

    // Verify the update
    const updatedResult = await client.query(
      "SELECT * FROM users WHERE id = $1",
      [userId]
    );

    if (updatedResult.rows.length > 0) {
      const updated = updatedResult.rows[0];
      console.log("Updated user data:", updated);
    }
  } catch (error) {
    console.error("Error updating user:", error);
  } finally {
    // Release the client back to the pool
    client.release();

    // End the pool - important to let the program exit
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
