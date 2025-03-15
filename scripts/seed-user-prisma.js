import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function seedUser() {
  const prisma = new PrismaClient();

  try {
    console.log("Starting user seeding process with Prisma client...");

    // Create or update user using Prisma client
    const user = await prisma.user.upsert({
      where: { id: "user_2txphAtnvJC6BDsUE7jSd6UmD4d" },
      update: {
        email: "lucasmartinbuilding@gmail.com",
        role: "ADMIN",
      },
      create: {
        id: "user_2txphAtnvJC6BDsUE7jSd6UmD4d",
        email: "lucasmartinbuilding@gmail.com",
        firstName: null,
        lastName: null,
        password: "",
        role: "ADMIN",
      },
    });

    console.log("User created or updated successfully:", user);
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
