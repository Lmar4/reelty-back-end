import { PostHog } from 'posthog-node';

// Initialize PostHog client
const posthogClient = new PostHog(
  process.env.POSTHOG_API_KEY || '',
  {
    host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    flushAt: 20, // Buffer size for events before sending
    flushInterval: 10000 // Flush interval in milliseconds
  }
);

export const analytics = {
  /**
   * Track an event in PostHog
   */
  track: async (
    eventName: string,
    userId: string,
    properties?: Record<string, any>
  ) => {
    try {
      await posthogClient.capture({
        distinctId: userId,
        event: eventName,
        properties
      });
    } catch (error) {
      console.error('PostHog tracking error:', error);
    }
  },

  /**
   * Identify a user in PostHog
   */
  identify: async (
    userId: string,
    properties: Record<string, any>
  ) => {
    try {
      await posthogClient.identify({
        distinctId: userId,
        properties
      });
    } catch (error) {
      console.error('PostHog identify error:', error);
    }
  },

  /**
   * Flush events manually (useful before server shutdown)
   */
  flush: async () => {
    try {
      await posthogClient.flush();
    } catch (error) {
      console.error('PostHog flush error:', error);
    }
  }
};
