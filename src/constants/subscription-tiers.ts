export const SUBSCRIPTION_TIERS = {
  BASIC: "550e8400-e29b-41d4-a716-446655440000",
  PRO: "550e8400-e29b-41d4-a716-446655440001",
  ENTERPRISE: "550e8400-e29b-41d4-a716-446655440002",
  AGENCY: "550e8400-e29b-41d4-a716-446655440004",
  ADMIN: "550e8400-e29b-41d4-a716-446655440003",
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

// Helper function to check if a tier is an agency tier
export const isAgencyTier = (id: SubscriptionTierId): boolean => {
  return id === SUBSCRIPTION_TIERS.AGENCY;
};

// Helper function to get max users allowed for a tier
export const getMaxUsersForTier = (id: SubscriptionTierId): number => {
  switch (id) {
    case SUBSCRIPTION_TIERS.AGENCY:
      return 10; // Default max users for agency
    case SUBSCRIPTION_TIERS.ENTERPRISE:
      return 5;
    case SUBSCRIPTION_TIERS.PRO:
      return 1;
    case SUBSCRIPTION_TIERS.BASIC:
      return 1;
    case SUBSCRIPTION_TIERS.ADMIN:
      return -1; // Unlimited
    default:
      return 1;
  }
};
