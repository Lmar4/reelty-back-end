import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function seedUser() {
  const prisma = new PrismaClient();

  try {
    console.log("Starting user seeding process with SQL...");

    // Check if user already exists
    const existingUser = await prisma.$queryRaw`
      SELECT id FROM "User" WHERE id = 'user_2uC2Psx4KWyYtFeWOuGg7FohB3t'
    `;

    if (existingUser && existingUser.length > 0) {
      console.log("User already exists, skipping creation");
      return;
    }

    // Insert user directly with SQL
    await prisma.$executeRaw`
      INSERT INTO "User" (
        id, 
        email, 
        "firstName", 
        "lastName", 
        password, 
        role, 
        "createdAt", 
        "updatedAt"
      ) 
      VALUES (
        'user_2uC2Psx4KWyYtFeWOuGg7FohB3t', 
        'antonio.correa@gmail.com', 
        NULL, 
        NULL, 
        '', 
        'ADMIN', 
        NOW(), 
        NOW()
      )
    `;

    console.log("User created successfully");

    // Get the subscription tier ID
    const subscriptionTier = await prisma.$queryRaw`
      SELECT id FROM "SubscriptionTier" WHERE "tierId" = 'REELTY_PRO_PLUS'
    `;

    if (!subscriptionTier || subscriptionTier.length === 0) {
      console.error("Subscription tier not found");
      return;
    }

    // Create subscription
    const subscriptionResult = await prisma.$executeRaw`
      INSERT INTO "Subscription" (
        id,
        "userId",
        "tierId",
        status,
        "createdAt",
        "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        'user_2uC2Psx4KWyYtFeWOuGg7FohB3t',
        'REELTY_PRO_PLUS',
        'ACTIVE',
        NOW(),
        NOW()
      )
      RETURNING id
    `;

    console.log("Subscription created successfully");

    // Get the subscription ID
    const subscription = await prisma.$queryRaw`
      SELECT id FROM "Subscription" 
      WHERE "userId" = 'user_2uC2Psx4KWyYtFeWOuGg7FohB3t' 
      ORDER BY "createdAt" DESC 
      LIMIT 1
    `;

    if (subscription && subscription.length > 0) {
      // Update user with active subscription
      await prisma.$executeRaw`
        UPDATE "User"
        SET "activeSubscriptionId" = ${subscription[0].id}
        WHERE id = 'user_2uC2Psx4KWyYtFeWOuGg7FohB3t'
      `;
      console.log("User updated with active subscription");
    }

    // Get the FREE tier for credits
    const freeTier = await prisma.$queryRaw`
      SELECT "creditsPerInterval" FROM "SubscriptionTier" WHERE "tierId" = 'FREE'
    `;

    if (!freeTier || freeTier.length === 0) {
      console.error("Free tier not found");
      return;
    }

    // Create listing credit
    await prisma.$executeRaw`
      INSERT INTO "ListingCredit" (
        id,
        "userId",
        "creditsRemaining",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        gen_random_uuid(),
        'user_2uC2Psx4KWyYtFeWOuGg7FohB3t',
        ${freeTier[0].creditsPerInterval},
        NOW(),
        NOW()
      )
    `;

    console.log("Listing credit created successfully");

    // Create credit log
    await prisma.$executeRaw`
      INSERT INTO "CreditLog" (
        id,
        "userId",
        amount,
        reason,
        "createdAt"
      )
      VALUES (
        gen_random_uuid(),
        'user_2uC2Psx4KWyYtFeWOuGg7FohB3t',
        ${freeTier[0].creditsPerInterval},
        'Initial trial credit (FREE)',
        NOW()
      )
    `;

    console.log("Credit log created successfully");
  } catch (error) {
    console.error("Error seeding user:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seeding function
seedUser()
  .then(() => console.log("Seeding completed"))
  .catch((error) => console.error("Seeding failed:", error));
