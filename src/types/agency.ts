export interface AgencyInput {
  name: string;
  maxUsers: number;
  ownerId: string;
}

export interface BulkDiscountInput {
  name: string;
  description: string;
  discountPercent: number;
  maxUsers: number;
  expiresAt?: Date;
}
