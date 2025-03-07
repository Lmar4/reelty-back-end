import { analytics } from "./posthog.js";
import {
  AnalyticsEvent,
  UserProperties,
  PhotoEvent,
  SearchEvent,
  CreditEvent,
  PerformanceEvent,
} from "./types.js";

export class AnalyticsService {
  /**
   * Track user identification
   */
  static async identifyUser(
    userId: string,
    properties: UserProperties
  ): Promise<void> {
    await analytics.identify(userId, properties);
  }

  /**
   * Track photo-related events
   */
  static async trackPhotoEvent(
    event: AnalyticsEvent,
    data: PhotoEvent
  ): Promise<void> {
    await analytics.track(event, data.userId, data);
  }

  /**
   * Track search-related events
   */
  static async trackSearchEvent(data: SearchEvent): Promise<void> {
    await analytics.track(AnalyticsEvent.SEARCH_PERFORMED, data.userId, data);
  }

  /**
   * Track credit-related events
   */
  static async trackCreditEvent(
    event: AnalyticsEvent,
    data: CreditEvent
  ): Promise<void> {
    await analytics.track(event, data.userId, data);
  }

  /**
   * Track performance metrics
   */
  static async trackPerformance(data: PerformanceEvent): Promise<void> {
    await analytics.track(
      AnalyticsEvent.PERFORMANCE_METRIC,
      data.userId || "system",
      data
    );
  }

  /**
   * Track API errors
   */
  static async trackError(
    userId: string,
    error: Error,
    context: Record<string, unknown>
  ): Promise<void> {
    await analytics.track(AnalyticsEvent.API_ERROR, userId, {
      error: error.message,
      stack: error.stack,
      ...context,
    });
  }
}
