import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function seedUser() {
  const prisma = new PrismaClient();

  try {
    console.log("Starting user seeding process with SQL...");

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
      ON CONFLICT (id) DO UPDATE SET
        email = 'antonio.correa@gmail.com',
        role = 'ADMIN'
    `;

    console.log("User created or updated successfully");
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
