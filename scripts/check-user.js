import pkg from "@prisma/client";
const { PrismaClient } = pkg;

async function checkUser() {
  const prisma = new PrismaClient();

  try {
    console.log("Checking if user exists...");

    const user = await prisma.user.findUnique({
      where: { id: "user_2uC2Psx4KWyYtFeWOuGg7FohB3t" },
    });

    if (user) {
      console.log("User found:", user);
    } else {
      console.log("User not found");
    }
  } catch (error) {
    console.error("Error checking user:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
checkUser()
  .then(() => console.log("Check completed"))
  .catch((error) => console.error("Check failed:", error));
