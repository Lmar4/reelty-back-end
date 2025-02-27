/**
 * Map Capture Configuration
 *
 * Central configuration for map capture service settings.
 * Includes browser arguments, timeouts, and cache settings.
 *
 * @module MapCaptureConfig
 */

export const MAP_CAPTURE_CONFIG = {
  /**
   * Puppeteer browser launch arguments
   * Configured for headless operation and optimal performance
   */
  BROWSER_ARGS: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--window-size=1920,3413",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--ignore-certificate-errors",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--single-process",
    "--no-zygote",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-site-isolation-trials",
  ],

  /**
   * Timeout settings for various operations
   */
  TIMEOUTS: {
    /** Maximum time to wait for map to load (ms) */
    MAP_LOAD: 60000,
    /** Time between frame captures (ms) */
    FRAME_CAPTURE: 100,
    /** Initial wait time after map load (ms) */
    INITIAL_LOAD: 5000,
  },

  /**
   * Cache configuration settings
   */
  CACHE: {
    /** Maximum number of videos to keep in cache */
    MAX_SIZE: 100,
    /** How long to keep videos in cache (ms) */
    DURATION: 24 * 60 * 60 * 1000, // 24 hours
    /** How often to run cache cleanup (ms) */
    CLEANUP_INTERVAL: 60 * 60 * 1000, // 1 hour
  },

  /**
   * FFmpeg configuration settings for video generation
   */
  FFMPEG: {
    FPS: "30",
    DURATION: "2", // Update to match 60 frames at 30 FPS (2 seconds)
    CODEC: "libx264",
    PRESET: "medium",
    CRF: "23",
    PIXEL_FORMAT: "yuv420p",
    BITRATE: "2M",
  },
};
