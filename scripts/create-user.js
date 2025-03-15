import { PrismaClient } from "@prisma/client";
import pg from "pg";
const { Pool } = pg;

const prisma = new PrismaClient();

async function main() {
  let pool = null;

  try {
    const userId = "user_2tK42UBB3pv3TX032JsSc51rgNH";
    const userEmail = "new-pro-plus-user@example.com"; // You can change this email as needed

    // Check if the user already exists
    const existingUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (existingUser) {
      console.log(`User with ID ${userId} already exists. Aborting creation.`);
      return;
    }

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

      // Create the new user with REELTY_PRO_PLUS tier and ACTIVE subscription
      await client.query(
        `INSERT INTO users (
          id, 
          email, 
          password, 
          "role", 
          "subscriptionStatus", 
          "currentTierId", 
          "createdAt", 
          "updatedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          userEmail,
          "$2a$10$randomhashedpassword", // This is a placeholder - in a real scenario, you'd properly hash a password
          "ADMIN", // Setting role to ADMIN
          "ACTIVE", // Setting subscription status to ACTIVE
          "550e8400-e29b-41d4-a716-446655440003", // REELTY_PRO_PLUS tier UUID
          new Date(),
          new Date(),
        ]
      );

      console.log(`User created with ID: ${userId}`);
      console.log(`Email: ${userEmail}`);
      console.log(`Role: ADMIN`);
      console.log(`Subscription Status: ACTIVE`);
      console.log(`Tier: REELTY_PRO_PLUS`);

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

    // Fetch the created user to confirm
    const createdUser = await prisma.user.findUnique({
      where: { id: userId },
      include: { currentTier: true },
    });

    if (createdUser) {
      console.log("Created user data:", {
        id: createdUser.id,
        email: createdUser.email,
        role: createdUser.role,
        subscriptionStatus: createdUser.subscriptionStatus,
        currentTierId: createdUser.currentTierId,
        currentTier: createdUser.currentTier
          ? {
              id: createdUser.currentTier.id,
              name: createdUser.currentTier.name,
              tierId: createdUser.currentTier.tierId,
            }
          : null,
      });
    } else {
      console.log("Failed to retrieve the created user.");
    }
  } catch (error) {
    console.error("Error creating user:", error);
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
