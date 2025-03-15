import pkg from "@prisma/client";
const { PrismaClient, SubscriptionTierId } = pkg;

async function seedUser() {
  const prisma = new PrismaClient();

  try {
    console.log("Starting user seeding process...");

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { id: "user_2uC2Psx4KWyYtFeWOuGg7FohB3t" },
    });

    if (existingUser) {
      console.log("User already exists, skipping creation");
      return;
    }

    // Get the FREE tier details
    const freeTier = await prisma.subscriptionTier.findUnique({
      where: { tierId: SubscriptionTierId.FREE },
    });

    if (!freeTier) {
      console.error("Free tier not found in database");
      return;
    }

    // Create the user with a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create the user
      const user = await tx.user.create({
        data: {
          id: "user_2uC2Psx4KWyYtFeWOuGg7FohB3t",
          email: "antonio.correa@gmail.com",
          firstName: null,
          lastName: null,
          password: "",
          role: "ADMIN",
          subscriptions: {
            create: {
              tierId: SubscriptionTierId.REELTY_PRO_PLUS,
              status: "ACTIVE",
            },
          },
        },
        include: {
          subscriptions: true,
        },
      });

      // Set the active subscription reference
      if (user.subscriptions && user.subscriptions.length > 0) {
        const subscription = user.subscriptions[0];
        await tx.user.update({
          where: { id: user.id },
          data: {
            activeSubscriptionId: subscription.id,
          },
        });
      }

      // Create initial credit
      await tx.listingCredit.create({
        data: {
          userId: user.id,
          creditsRemaining: freeTier.creditsPerInterval,
        },
      });

      // Log the credit creation
      await tx.creditLog.create({
        data: {
          userId: user.id,
          amount: freeTier.creditsPerInterval,
          reason: `Initial trial credit (${freeTier.name})`,
        },
      });

      return user;
    });

    console.log("User created successfully:", result);
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
