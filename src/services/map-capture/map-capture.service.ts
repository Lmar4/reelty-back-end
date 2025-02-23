/**
 * Map Capture Service
 *
 * Handles the generation of map videos by capturing frames of Google Maps with zoom animations.
 * Uses Puppeteer for browser automation and ffmpeg for video processing.
 *
 * Features:
 * - Automated map video generation with smooth zoom transitions
 * - Resource cleanup and memory management
 * - Error handling and retry mechanisms
 * - Health monitoring
 *
 * Requirements:
 * - Google Maps API key in environment variables
 * - Chrome/Chromium installed for Puppeteer
 * - Writable temp directory
 *
 * @module MapCaptureService
 */

import * as crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import { constants, promises as fsPromises, mkdirSync } from "fs";
import * as path from "path";
import puppeteer, { Browser, Page } from "puppeteer";
import { logger } from "../../utils/logger.js";
import { tempFileManager } from "../storage/temp-file.service.js";
import { MAP_CAPTURE_CONFIG } from "./map-capture.config.js";

// Declare types for Google Maps objects
declare global {
  interface Window {
    mapInstance: any;
    google: {
      maps: {
        Map: any;
        event: {
          addListenerOnce: (
            instance: any,
            event: string,
            handler: () => void
          ) => void;
        };
      };
    };
  }
}

export class MapCaptureService {
  private static instance: MapCaptureService;
  private readonly CACHE_DIR: string;
  private readonly CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
  private googleMapsApiKey: string = "";
  private browser: Browser | null = null;

  /**
   * Private constructor for singleton pattern.
   * Validates environment variables and setup.
   */
  private constructor() {
    this.CACHE_DIR = path.join(
      process.env.TEMP_OUTPUT_DIR || "./temp",
      "map-cache"
    );
    // Ensure cache directory exists synchronously
    try {
      mkdirSync(this.CACHE_DIR, { recursive: true });
    } catch (error) {
      logger.error("Failed to create cache directory:", { error });
      throw error;
    }

    this.validateEnvironment().catch((error) => {
      logger.error("Failed to validate environment:", { error });
      throw error;
    });
  }

  /**
   * Gets the singleton instance of MapCaptureService.
   * @returns {MapCaptureService} The singleton instance
   */
  public static getInstance(): MapCaptureService {
    if (!MapCaptureService.instance) {
      MapCaptureService.instance = new MapCaptureService();
    }
    return MapCaptureService.instance;
  }

  /**
   * Validates required environment variables and directory permissions.
   * @throws {Error} If required environment variables are missing or temp directory is not writable
   */
  private async validateEnvironment(): Promise<void> {
    const requiredEnvVars = {
      TEMP_DIR: process.env.TEMP_DIR || "./temp",
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    };

    // Validate required environment variables
    Object.entries(requiredEnvVars).forEach(([key, value]) => {
      if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    });

    // Since we've validated that GOOGLE_MAPS_API_KEY exists, we can safely assert its type
    this.googleMapsApiKey = requiredEnvVars.GOOGLE_MAPS_API_KEY as string;

    // Validate temp directory exists and is writable
    await this.validateTempDir(requiredEnvVars.TEMP_DIR);
  }

  private async validateTempDir(tempDir: string): Promise<void> {
    try {
      await fsPromises.access(tempDir, constants.W_OK);
    } catch (error) {
      throw new Error(`Temp directory ${tempDir} is not writable`);
    }
  }

  /**
   * Validates that the Google Map has loaded properly in the page.
   * @param {Page} page - Puppeteer page instance
   * @throws {Error} If map fails to load within timeout period
   */
  private async validateMapLoaded(page: Page): Promise<void> {
    try {
      await page.waitForFunction(
        function (this: Window) {
          return (
            typeof this.google !== "undefined" &&
            typeof this.mapInstance !== "undefined" &&
            this.mapInstance.getDiv().getBoundingClientRect().width > 0
          );
        },
        { timeout: MAP_CAPTURE_CONFIG.TIMEOUTS.MAP_LOAD }
      );
    } catch (error) {
      throw new Error(
        "Map failed to load properly: " +
          (error instanceof Error ? error.message : "Unknown error")
      );
    }
  }

  /**
   * Cleans up page resources and closes the page.
   * @param {Page} page - Puppeteer page instance
   */
  private async clearPageResources(page: Page): Promise<void> {
    try {
      await page
        .evaluate(function (this: Window) {
          if (this.google) delete (this as any).google;
          if (this.mapInstance) delete (this as any).mapInstance;
        })
        .catch(() => {
          // Ignore evaluation errors on detached frames
        });
      await page.close().catch(() => {
        // Ignore close errors if page is already closed
      });
    } catch (error) {
      // Log but don't throw - we want to continue cleanup even if this fails
      logger.warn("Error during page resource cleanup:", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Crops and resizes a captured frame to portrait orientation.
   * @param {string} inputPath - Path to input image
   * @param {string} outputPath - Path for output image
   */
  private async cropToPortrait(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    // Since we're already capturing at 768x1280, we can just copy the file
    await fsPromises.copyFile(inputPath, outputPath);
  }

  /**
   * Cleans up temporary frame files.
   * @param {string} framesDir - Directory containing frame files
   */
  private async cleanupFrames(framesDir: string): Promise<void> {
    try {
      const files = await fsPromises.readdir(framesDir);
      await Promise.all(
        files
          .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
          .map((f) => fsPromises.unlink(path.join(framesDir, f)))
      );
      logger.info("Cleaned up frame files successfully", { framesDir });
    } catch (error) {
      logger.error("Failed to cleanup frames:", {
        error: error instanceof Error ? error.message : "Unknown error",
        framesDir,
      });
    }
  }

  /**
   * Captures a series of map frames with zoom animation.
   * @param {Object} coordinates - Latitude and longitude coordinates
   * @param {number} coordinates.lat - Latitude
   * @param {number} coordinates.lng - Longitude
   * @returns {Promise<string>} Path to directory containing captured frames
   */
  public async captureMapFrames(
    coordinates: {
      lat: number;
      lng: number;
    },
    page: Page
  ): Promise<string> {
    const cacheKey = this.generateMapCacheKey(coordinates);
    const framesDir = path.join(this.CACHE_DIR, `frames-${cacheKey}`);

    try {
      // Ensure frames directory exists
      await fsPromises.mkdir(framesDir, { recursive: true });

      // Set viewport to match exact target dimensions
      await page.setViewport({ width: 768, height: 1280 });

      // Create HTML content for the map with additional styles
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Map Animation</title>
            <script src="https://maps.googleapis.com/maps/api/js?key=${this.googleMapsApiKey}"></script>
            <style>
              html, body { 
                height: 100%; 
                margin: 0; 
                padding: 0;
                width: 768px;
                height: 1280px;
                overflow: hidden;
              }
              #map { 
                width: 768px;
                height: 1280px;
                position: absolute; 
                top: 0; 
                left: 0;
              }
            </style>
          </head>
          <body>
            <div id="map"></div>
            <script>
              let mapInstance;
              function initMap() {
                const location = { lat: ${coordinates.lat}, lng: ${coordinates.lng} };
                mapInstance = new google.maps.Map(document.getElementById('map'), {
                  center: location,
                  zoom: 4,
                  mapTypeId: 'satellite',
                  tilt: 0,
                  disableDefaultUI: true,
                  styles: [
                    {
                      featureType: "poi",
                      elementType: "labels",
                      stylers: [{ visibility: "off" }]
                    },
                    {
                      featureType: "transit",
                      elementType: "labels",
                      stylers: [{ visibility: "off" }]
                    }
                  ]
                });
                window.mapInstance = mapInstance;
              }
              initMap();
            </script>
          </body>
        </html>
      `;

      // Write HTML to a temporary file
      const tempHtmlPath = path.join(framesDir, "map.html");
      await fsPromises.writeFile(tempHtmlPath, htmlContent);

      // Load the HTML file with proper absolute path
      const absoluteHtmlPath = path.resolve(tempHtmlPath);
      await page.goto(
        `file://${
          absoluteHtmlPath.startsWith("/") ? "" : "/"
        }${absoluteHtmlPath}`
      );
      await page.waitForFunction("window.mapInstance !== undefined");

      console.log("Map instance created, waiting for initial load...");

      // Set up the animation with proper loading checks
      await page.evaluate(function (
        this: Window & { mapInstance: any },
        coords: { lat: number; lng: number }
      ) {
        const map = this.mapInstance;

        // Center map and ensure it's loaded
        map.setCenter(coords);
        map.setZoom(4);

        // Wait for map to be idle (tiles loaded)
        return new Promise<void>((resolve) => {
          this.google.maps.event.addListenerOnce(map, "idle", () => {
            // Additional wait to ensure all tiles are rendered
            setTimeout(resolve, 3000);
          });
        });
      },
      coordinates);

      console.log("Initial map view loaded, starting zoom sequence...");

      // Capture frames with smooth zoom transition
      const START_ZOOM = 4;
      const END_ZOOM = 19.5;
      const FRAME_COUNT = 60;

      for (let i = 0; i < FRAME_COUNT; i++) {
        const progress = i / (FRAME_COUNT - 1);
        const currentZoom = START_ZOOM + (END_ZOOM - START_ZOOM) * progress;

        await page.evaluate(function (
          this: Window & { mapInstance: any },
          zoom: number
        ) {
          const map = this.mapInstance;
          map.setZoom(zoom);
        },
        currentZoom);

        // Quick check for map idle state
        await page.evaluate(function (this: Window & { mapInstance: any }) {
          const map = this.mapInstance;
          return new Promise<void>((resolve) => {
            this.google.maps.event.addListenerOnce(map, "idle", () =>
              resolve()
            );
          });
        });

        // Shorter wait time for tiles
        await new Promise((resolve) =>
          setTimeout(resolve, MAP_CAPTURE_CONFIG.TIMEOUTS.FRAME_CAPTURE)
        );

        console.log(
          `Capturing frame ${
            i + 1
          }/${FRAME_COUNT} at zoom level ${currentZoom.toFixed(1)}`
        );

        // Capture frame
        const tempFramePath = path.join(
          framesDir,
          `temp_frame_${i.toString().padStart(2, "0")}.jpg`
        );
        const finalFramePath = path.join(
          framesDir,
          `frame_${i.toString().padStart(2, "0")}.jpg`
        );

        await page.screenshot({
          path: tempFramePath,
          type: "jpeg",
          quality: 90,
        });

        // Crop to portrait and clean up temp file
        await this.cropToPortrait(tempFramePath, finalFramePath);
        await fsPromises.unlink(tempFramePath);
      }

      // Only clean up after all frames are captured and processed
      await fsPromises.unlink(tempHtmlPath);

      return framesDir;
    } catch (error) {
      logger.error("Failed to capture map frames:", {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
      });
      throw error;
    } finally {
      // Move cleanup to after video creation
      // We'll handle browser and page cleanup in generateMapVideo
    }
  }

  /**
   * Creates a video from captured frames.
   * @param {string} framesDir - Directory containing frame files
   * @param {Browser} browser - Puppeteer browser instance to clean up
   * @param {Page} page - Puppeteer page instance to clean up
   * @returns {Promise<string>} Path to generated video file
   */
  public async createVideo(
    framesDir: string,
    browser: Browser | null,
    page: Page | null
  ): Promise<string> {
    try {
      const outputPath = await tempFileManager.createFile("map.mp4");

      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(path.join(framesDir, "frame_%02d.jpg"))
          .inputFPS(24)
          .output(outputPath.path)
          .outputOptions([
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "18",
            "-r",
            "24",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high",
            "-level",
            "4.0",
            "-movflags",
            "+faststart",
            "-t",
            "3",
          ])
          .on("progress", (progress) => {
            logger.info("FFmpeg progress", {
              frames: progress.frames,
              currentFps: progress.currentFps,
              percent: progress.percent,
              targetSize: progress.targetSize,
            });
          })
          .on("end", async () => {
            try {
              // Clean up frames first
              await this.cleanupFrames(framesDir);

              // Then clean up browser resources
              if (page) {
                await this.clearPageResources(page).catch((err) => {
                  logger.warn("Error clearing page resources:", {
                    error: err instanceof Error ? err.message : "Unknown error",
                  });
                });
              }
              if (browser) {
                await browser.close().catch((err) => {
                  logger.warn("Error closing browser:", {
                    error: err instanceof Error ? err.message : "Unknown error",
                  });
                });
              }

              logger.info("Map video created successfully", {
                outputPath: outputPath.path,
              });
              resolve(outputPath.path);
            } catch (error) {
              reject(error);
            }
          })
          .on("error", (err) => {
            logger.error("Failed to create map video:", {
              error: err.message,
              framesDir,
            });
            reject(err);
          })
          .run();
      });
    } catch (error) {
      logger.error("Failed to create map video:", {
        error: error instanceof Error ? error.message : "Unknown error",
        framesDir,
      });
      throw error;
    }
  }

  private generateMapCacheKey(coordinates: {
    lat: number;
    lng: number;
  }): string {
    // Round coordinates to 6 decimal places for consistent cache keys
    const lat = Math.round(coordinates.lat * 1000000) / 1000000;
    const lng = Math.round(coordinates.lng * 1000000) / 1000000;
    return crypto.createHash("md5").update(`${lat},${lng}`).digest("hex");
  }

  private async validateCachedFile(filePath: string): Promise<boolean> {
    try {
      const stats = await fsPromises.stat(filePath);
      const age = Date.now() - stats.mtime.getTime();
      const isValid = age < this.CACHE_DURATION_MS;

      logger.info("Cache validation result:", {
        filePath,
        age: Math.round(age / 1000), // Convert to seconds for readability
        maxAge: Math.round(this.CACHE_DURATION_MS / 1000),
        isValid,
      });

      return isValid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.info("Cache file not found:", { filePath });
      } else {
        logger.warn("Error validating cache file:", {
          filePath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return false;
    }
  }

  /**
   * Generates a map video for given coordinates with caching and retry logic.
   * @param {Object} coordinates - Latitude and longitude coordinates
   * @param {string} jobId - Unique identifier for the job
   * @returns {Promise<string>} Path to generated video file
   */
  public async generateMapVideo(
    coordinates: { lat: number; lng: number },
    jobId: string
  ): Promise<string> {
    const cacheKey = this.generateMapCacheKey(coordinates);
    const cachedPath = path.join(this.CACHE_DIR, `map-${cacheKey}.mp4`);
    const framesDir = path.join(this.CACHE_DIR, `frames-${cacheKey}`);

    try {
      // Check if cached file exists and is valid
      if (await this.validateCachedFile(cachedPath)) {
        logger.info(`[${jobId}] Cache hit for map video`, {
          cacheKey,
          coordinates,
          cachedPath,
        });
        return cachedPath;
      }

      logger.info(`[${jobId}] Cache miss for map video, generating new`, {
        cacheKey,
        coordinates,
      });

      // Ensure frames directory exists
      await fsPromises.mkdir(framesDir, { recursive: true });

      // Generate new map video
      const browser = await puppeteer.launch({
        headless: true,
        args: MAP_CAPTURE_CONFIG.BROWSER_ARGS,
      });
      const page = await browser.newPage();

      try {
        await this.captureMapFrames(coordinates, page);
        const videoPath = await this.createVideo(framesDir, browser, page);

        // Copy to cache location
        await fsPromises.copyFile(videoPath, cachedPath);

        return cachedPath;
      } finally {
        // Cleanup resources
        await this.clearPageResources(page).catch((err) => {
          logger.warn("Error clearing page resources:", {
            error: err instanceof Error ? err.message : "Unknown error",
          });
        });
        await browser.close().catch((err) => {
          logger.warn("Error closing browser:", {
            error: err instanceof Error ? err.message : "Unknown error",
          });
        });
      }
    } catch (error) {
      logger.error(`[${jobId}] Error generating map video`, {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
        cacheKey,
      });
      throw error;
    }
  }

  /**
   * Performs a health check of the service.
   * Verifies browser launch capability and environment setup.
   * @returns {Promise<Object>} Health check results
   */
  public async healthCheck(): Promise<{
    status: "healthy" | "unhealthy";
    details: Record<string, unknown>;
  }> {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox"],
      });
      await browser.close();

      return {
        status: "healthy",
        details: {
          browserLaunch: true,
          googleMapsApiKey: !!this.googleMapsApiKey,
          tempDirWritable: true,
        },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        details: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }
}

// Export singleton instance
export const mapCaptureService = MapCaptureService.getInstance();
