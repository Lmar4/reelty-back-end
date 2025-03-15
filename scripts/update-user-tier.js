import { PrismaClient } from "@prisma/client";
import pg from "pg";
const { Pool } = pg;

const prisma = new PrismaClient();

async function main() {
  let pool = null;

  try {
    const userId = "user_2txphAtnvJC6BDsUE7jSd6UmD4d";

    // First, check if the user exists using Prisma
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      console.error(`User with ID ${userId} not found`);
      return;
    }

    console.log("Current user data:", {
      id: user.id,
      email: user.email,
      role: user.role,
      subscriptionStatus: user.subscriptionStatus,
      currentTierId: user.currentTierId,
    });

    // Get the database URL from environment
    const databaseUrl = process.env.DATABASE_URL;

    // Create a new connection pool
    pool = new Pool({
      connectionString: databaseUrl,
    });

    // Connect to the database directly
    const client = await pool.connect();

    try {
      // Start a transaction
      await client.query("BEGIN");

      // Temporarily disable all triggers
      await client.query("SET session_replication_role = replica");

      // Update subscription status to ACTIVE
      await client.query(
        `UPDATE users SET "subscriptionStatus" = $1 WHERE id = $2`,
        ["ACTIVE", userId]
      );

      console.log(`Subscription status updated to ACTIVE`);

      // Update tier to REELTY_PRO_PLUS using the UUID value from the schema
      await client.query(
        `UPDATE users SET "currentTierId" = $1 WHERE id = $2`,
        ["550e8400-e29b-41d4-a716-446655440003", userId]
      );

      console.log(`Tier updated to REELTY_PRO_PLUS (using UUID)`);

      // Re-enable triggers
      await client.query("SET session_replication_role = default");

      // Commit the transaction
      await client.query("COMMIT");
    } catch (error) {
      // Rollback in case of error
      await client.query("ROLLBACK");
      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }

    // Fetch the updated user to confirm changes
    const verifiedUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { currentTier: true },
    });

    console.log("Updated user data:", {
      id: verifiedUser.id,
      email: verifiedUser.email,
      role: verifiedUser.role,
      subscriptionStatus: verifiedUser.subscriptionStatus,
      currentTierId: verifiedUser.currentTierId,
      currentTier: verifiedUser.currentTier
        ? {
            id: verifiedUser.currentTier.id,
            name: verifiedUser.currentTier.name,
            tierId: verifiedUser.currentTier.tierId,
          }
        : null,
    });
  } catch (error) {
    console.error("Error updating user:", error);
    if (error.detail) console.error("Error detail:", error.detail);
    if (error.hint) console.error("Error hint:", error.hint);
    if (error.where) console.error("Error where:", error.where);
  } finally {
    await prisma.$disconnect();
    if (pool) {
      await pool.end();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
