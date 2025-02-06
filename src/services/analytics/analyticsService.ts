import { analytics } from './posthog';
import {
  AnalyticsEvent,
  UserProperties,
  PhotoEvent,
  SearchEvent,
  CreditEvent,
  PerformanceEvent
} from './types';

export class AnalyticsService {
  /**
   * Track user identification
   */
  static async identifyUser(userId: string, properties: UserProperties) {
    await analytics.identify(userId, properties);
  }

  /**
   * Track photo-related events
   */
  static async trackPhotoEvent(event: AnalyticsEvent, data: PhotoEvent) {
    await analytics.track(event, data.userId, data);
  }

  /**
   * Track search-related events
   */
  static async trackSearchEvent(data: SearchEvent) {
    await analytics.track(AnalyticsEvent.SEARCH_PERFORMED, data.userId, data);
  }

  /**
   * Track credit-related events
   */
  static async trackCreditEvent(event: AnalyticsEvent, data: CreditEvent) {
    await analytics.track(event, data.userId, data);
  }

  /**
   * Track performance metrics
   */
  static async trackPerformance(data: PerformanceEvent) {
    await analytics.track(
      AnalyticsEvent.PERFORMANCE_METRIC,
      data.userId || 'system',
      data
    );
  }

  /**
   * Track API errors
   */
  static async trackError(
    userId: string,
    error: Error,
    context: Record<string, any>
  ) {
    await analytics.track(AnalyticsEvent.API_ERROR, userId, {
      error: error.message,
      stack: error.stack,
      ...context
    });
  }
}
