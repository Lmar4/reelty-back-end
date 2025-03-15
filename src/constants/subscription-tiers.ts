export const SUBSCRIPTION_TIERS = {
  FREE: "550e8400-e29b-41d4-a716-446655440000", // Free tier
  REELTY: "550e8400-e29b-41d4-a716-446655440001", // Basic/Reelty tier
  REELTY_PRO: "550e8400-e29b-41d4-a716-446655440002", // Pro tier
  REELTY_PRO_PLUS: "550e8400-e29b-41d4-a716-446655440003", // Pro+ tier
  LIFETIME: "550e8400-e29b-41d4-a716-446655440004", // Lifetime tier for beta testers
} as const;

export type SubscriptionTierId =
  (typeof SUBSCRIPTION_TIERS)[keyof typeof SUBSCRIPTION_TIERS];

// Helper function to check if a string is a valid tier ID
export const isValidTierId = (id: string): id is SubscriptionTierId => {
  return Object.values(SUBSCRIPTION_TIERS).includes(id as SubscriptionTierId);
};

// Helper function to get tier name from ID
export const getTierNameFromId = (id: SubscriptionTierId): string => {
  const entry = Object.entries(SUBSCRIPTION_TIERS).find(
    ([_, value]) => value === id
  );
  return entry ? entry[0] : "UNKNOWN";
};

// Helper function to get max users allowed for a tier
export const getMaxUsersForTier = (id: SubscriptionTierId): number => {
  switch (id) {
    case SUBSCRIPTION_TIERS.REELTY_PRO_PLUS:
      return -1; // Unlimited
    case SUBSCRIPTION_TIERS.REELTY_PRO:
      return 10;
    case SUBSCRIPTION_TIERS.REELTY:
      return 1;
    case SUBSCRIPTION_TIERS.FREE:
      return 1;
    case SUBSCRIPTION_TIERS.LIFETIME:
      return 1;
    default:
      return 1;
  }
};

// Helper function to get credits per interval for a tier
export const getCreditsForTier = (id: SubscriptionTierId): number => {
  switch (id) {
    case SUBSCRIPTION_TIERS.REELTY_PRO_PLUS:
      return 10; // 10 credits per month
    case SUBSCRIPTION_TIERS.REELTY_PRO:
      return 4; // 4 credits per month
    case SUBSCRIPTION_TIERS.REELTY:
      return 1; // 1 credit per month
    case SUBSCRIPTION_TIERS.FREE:
      return 0; // No credits
    case SUBSCRIPTION_TIERS.LIFETIME:
      return 24; // 24 credits (2 per month for a year)
    default:
      return 0;
  }
};
