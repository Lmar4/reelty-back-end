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
    /** Video codec to use */
    CODEC: "libx264",
    /** Encoding preset (faster = lower quality but more reliable) */
    PRESET: "medium", // Changed from "slow" to more reliable "medium"
    /** Constant Rate Factor (lower = better quality, 18-23 is good range) */
    CRF: "23", // Less aggressive quality setting
    /** Frame rate for output video */
    FPS: "30",
    /** Output format */
    FORMAT: "mp4",
    /** Pixel format */
    PIXEL_FORMAT: "yuv420p",
    /** Additional output options */
    OUTPUT_OPTIONS: [
      "-movflags",
      "+faststart",
      "-profile:v",
      "main", // Changed from high to more compatible main profile
      "-level",
      "4.0",
      "-max_muxing_queue_size",
      "9999", // Prevents muxing errors
      "-tune",
      "fastdecode", // Optimizes for playback compatibility
    ],
    /** Video duration in seconds */
    DURATION: "3",
    /** Bitrate for better compatibility */
    BITRATE: "2M", // Fixed bitrate option for better compatibility
  },
};
