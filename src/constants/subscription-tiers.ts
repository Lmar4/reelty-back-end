export const SUBSCRIPTION_TIERS = {
  BASIC: "550e8400-e29b-41d4-a716-446655440000",
  PRO: "550e8400-e29b-41d4-a716-446655440001",
  ENTERPRISE: "550e8400-e29b-41d4-a716-446655440002",
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
