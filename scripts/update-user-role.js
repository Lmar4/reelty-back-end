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
    const userId = "user_2tK42UBB3pv3TX032JsSc51rgNH";

    // First, check if the user exists
    const userResult = await client.query("SELECT * FROM users WHERE id = $1", [
      userId,
    ]);

    if (userResult.rows.length === 0) {
      console.error(`User with ID ${userId} not found`);
      return;
    }

    const user = userResult.rows[0];
    console.log("Current user data:", {
      id: user.id,
      email: user.email,
      role: user.role,
      subscriptionStatus: user.subscriptionStatus,
      currentTierId: user.currentTierId,
    });

    // Start a transaction
    await client.query("BEGIN");

    // Temporarily disable all triggers
    await client.query("SET session_replication_role = replica");

    // Update the role to ADMIN
    await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [
      "ADMIN",
      userId,
    ]);
    console.log("Role updated to ADMIN");

    // Re-enable triggers
    await client.query("SET session_replication_role = default");

    // Commit the transaction
    await client.query("COMMIT");

    // Verify the update
    const updatedResult = await client.query(
      "SELECT * FROM users WHERE id = $1",
      [userId]
    );

    if (updatedResult.rows.length > 0) {
      const updated = updatedResult.rows[0];
      console.log("Updated user data:", {
        id: updated.id,
        email: updated.email,
        role: updated.role,
        subscriptionStatus: updated.subscriptionStatus,
        currentTierId: updated.currentTierId,
      });
    }
  } catch (error) {
    console.error("Error updating user role:", error);
    if (error.detail) console.error("Error detail:", error.detail);
    if (error.hint) console.error("Error hint:", error.hint);
    if (error.where) console.error("Error where:", error.where);

    // If there was an error and we started a transaction, roll it back
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Error rolling back transaction:", rollbackError);
    }
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
