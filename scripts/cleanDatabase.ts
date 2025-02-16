import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function cleanDatabase() {
  try {
    console.log("Starting database cleanup...");

    // Delete independent tables first (no foreign key dependencies)
    console.log("Deleting CacheLock records...");
    await prisma.cacheLock.deleteMany();

    console.log("Deleting ListingLock records...");
    await prisma.listingLock.deleteMany();

    console.log("Deleting CachedAsset records...");
    await prisma.cachedAsset.deleteMany();

    console.log("Deleting ProcessedAsset records...");
    await prisma.processedAsset.deleteMany();

    // Delete tables with user dependencies in correct order
    console.log("Deleting SearchHistory records...");
    await prisma.searchHistory.deleteMany();

    console.log("Deleting ErrorLog records...");
    await prisma.errorLog.deleteMany();

    console.log("Deleting TempUpload records...");
    await prisma.tempUpload.deleteMany();

    // Delete video related records
    console.log("Deleting VideoGenerationJob records...");
    await prisma.videoGenerationJob.deleteMany();

    console.log("Deleting VideoJob records...");
    await prisma.videoJob.deleteMany();

    // Delete listing related records
    console.log("Deleting Photo records...");
    await prisma.photo.deleteMany();

    console.log("Deleting Listing records...");
    await prisma.listing.deleteMany();

    console.log("Deleting ListingCredit records...");
    await prisma.listingCredit.deleteMany();

    // Delete subscription related records
    console.log("Deleting SubscriptionHistory records...");
    await prisma.subscriptionHistory.deleteMany();

    console.log("Deleting SubscriptionLog records...");
    await prisma.subscriptionLog.deleteMany();

    // Delete credit and tier related records
    console.log("Deleting CreditLog records...");
    await prisma.creditLog.deleteMany();

    console.log("Deleting TierChange records...");
    await prisma.tierChange.deleteMany();

    // Delete asset related records
    console.log("Deleting Asset records...");
    await prisma.asset.deleteMany();

    // Delete template related records
    console.log("Deleting Template records...");
    await prisma.template.deleteMany();

    // Delete subscription tier related records
    console.log("Deleting SubscriptionTier records...");
    await prisma.subscriptionTier.deleteMany();

    // Delete bulk discount records
    console.log("Deleting BulkDiscount records...");
    await prisma.bulkDiscount.deleteMany();

    console.log("Database cleanup completed successfully!");
  } catch (error) {
    console.error("Error during database cleanup:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Execute the cleanup
cleanDatabase().catch((error) => {
  console.error("Failed to clean database:", error);
  process.exit(1);
});
