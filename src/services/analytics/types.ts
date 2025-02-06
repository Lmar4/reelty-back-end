export enum AnalyticsEvent {
  // User events
  USER_SIGNUP = 'user.signup',
  USER_LOGIN = 'user.login',
  USER_UPGRADED = 'user.upgraded',
  
  // Feature usage events
  PHOTO_UPLOADED = 'photo.uploaded',
  PHOTO_PROCESSED = 'photo.processed',
  SEARCH_PERFORMED = 'search.performed',
  
  // Credit events
  CREDITS_ADDED = 'credits.added',
  CREDITS_USED = 'credits.used',
  
  // System events
  API_ERROR = 'api.error',
  PERFORMANCE_METRIC = 'performance.metric'
}

export interface UserProperties {
  email: string;
  tier: string;
  createdAt: string;
  totalCredits: number;
  usedCredits: number;
}

export interface PhotoEvent {
  photoId: string;
  userId: string;
  processingTime?: number;
  fileSize?: number;
  fileType?: string;
  success: boolean;
  error?: string;
}

export interface SearchEvent {
  userId: string;
  query: string;
  resultCount: number;
  processingTime: number;
  filters?: Record<string, any>;
}

export interface CreditEvent {
  userId: string;
  amount: number;
  operation: 'add' | 'use';
  reason: string;
  remainingCredits: number;
}

export interface PerformanceEvent {
  endpoint: string;
  method: string;
  duration: number;
  status: number;
  userAgent?: string;
  userId?: string;
}
