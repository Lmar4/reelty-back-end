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

import puppeteer, { Browser, Page } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { tempFileManager } from "../storage/temp-file.service";
import { logger } from "../../utils/logger";
import { mapVideoCacheService } from "../map-cache/map-video-cache.service";
import { retryService } from "../retry/retry.service";
import { MAP_CAPTURE_CONFIG } from "./map-capture.config";

// Declare types for Google Maps objects
declare global {
  interface Window {
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
    mapInstance: any;
  }
}

export class MapCaptureService {
  private static instance: MapCaptureService;
  private googleMapsApiKey: string = "";
  private browser: Browser | null = null;

  /**
   * Private constructor for singleton pattern.
   * Validates environment variables and setup.
   */
  private constructor() {
    this.validateEnvironment();
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
  private validateEnvironment(): void {
    const requiredEnvVars = {
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
      TEMP_DIR: process.env.TEMP_DIR || "./temp",
    };

    const missingVars = Object.entries(requiredEnvVars)
      .filter(([_, value]) => !value)
      .map(([key]) => key);

    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(", ")}`
      );
    }

    this.googleMapsApiKey = requiredEnvVars.GOOGLE_MAPS_API_KEY!;

    // Validate temp directory exists and is writable
    const tempDir = requiredEnvVars.TEMP_DIR;
    try {
      fs.accessSync(tempDir, fs.constants.W_OK);
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
    await page.evaluate(function (this: Window) {
      delete (this as any).google;
      delete (this as any).mapInstance;
    });
    await page.close();
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
    // For 9:16 ratio from 1920x3413 input
    const targetWidth = 768; // Match Runway dimensions
    const targetHeight = 1280; // Match Runway dimensions

    // Calculate crop width to maintain 9:16 ratio
    const cropWidth = Math.round(targetHeight * (9 / 16)); // Calculate width based on 9:16 ratio
    const cropX = Math.floor((1920 - cropWidth) / 2); // Center horizontally

    await sharp(inputPath)
      .extract({
        left: cropX,
        top: 0,
        width: cropWidth,
        height: 3413, // Use full height, we'll resize after
      })
      .resize(targetWidth, targetHeight, {
        fit: "fill", // Since we've already established correct ratio
        position: "center",
      })
      .toFile(outputPath);
  }

  /**
   * Cleans up temporary frame files.
   * @param {string} framesDir - Directory containing frame files
   */
  private async cleanupFrames(framesDir: string): Promise<void> {
    try {
      const files = await fs.promises.readdir(framesDir);
      await Promise.all(
        files
          .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
          .map((f) => fs.promises.unlink(path.join(framesDir, f)))
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
  public async captureMapFrames(coordinates: {
    lat: number;
    lng: number;
  }): Promise<string> {
    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      const framesDir = await tempFileManager.createDirectory("map-frames");
      browser = await puppeteer.launch({
        headless: true,
        args: MAP_CAPTURE_CONFIG.BROWSER_ARGS,
        executablePath: process.env.CHROME_PATH || undefined,
      });

      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 3413 });

      // Create HTML content for the map with additional styles
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Map Animation</title>
            <script src="https://maps.googleapis.com/maps/api/js?key=${this.googleMapsApiKey}"></script>
            <style>
              #map { height: 100vh; width: 100vw; }
              body { margin: 0; }
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
                  zoom: 6,
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
      const tempHtmlPath = path.join(framesDir.path, "map.html");
      await fs.promises.writeFile(tempHtmlPath, htmlContent);

      // Load the HTML file and validate
      await page.goto(`file://${tempHtmlPath}`);
      await this.validateMapLoaded(page);

      // Wait for initial map load
      await new Promise((resolve) =>
        setTimeout(resolve, MAP_CAPTURE_CONFIG.TIMEOUTS.INITIAL_LOAD)
      );

      // Capture frames with smooth zoom transition
      const START_ZOOM = 6;
      const END_ZOOM = 22;
      const FRAME_COUNT = 90;

      for (let i = 0; i < FRAME_COUNT; i++) {
        const progress = i / (FRAME_COUNT - 1);
        const easeOut = 1 - Math.pow(1 - progress, 3);
        const currentZoom = START_ZOOM + (END_ZOOM - START_ZOOM) * easeOut;

        await page.evaluate(`
          if (typeof mapInstance !== 'undefined') {
            mapInstance.setZoom(${currentZoom});
          }
        `);

        // Wait for the map to be idle after zoom change
        await page.evaluate(function (this: Window) {
          return new Promise<void>((resolve) => {
            if (
              typeof this.google !== "undefined" &&
              typeof this.mapInstance !== "undefined"
            ) {
              this.google.maps.event.addListenerOnce(
                this.mapInstance,
                "idle",
                () => resolve()
              );
            } else {
              resolve();
            }
          });
        });

        // Reduced wait time between frames for smoother transitions
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Capture and process frame
        const tempFramePath = path.join(
          framesDir.path,
          `temp_frame_${i.toString().padStart(2, "0")}.jpg`
        );
        const finalFramePath = path.join(
          framesDir.path,
          `frame_${i.toString().padStart(2, "0")}.jpg`
        );

        await page.screenshot({
          path: tempFramePath,
          type: "jpeg",
          quality: 90,
        });

        // Crop to portrait and clean up temp file
        await this.cropToPortrait(tempFramePath, finalFramePath);
        await fs.promises.unlink(tempFramePath);

        logger.info(`Captured frame ${i + 1}/${FRAME_COUNT}`, {
          zoom: currentZoom.toFixed(1),
        });
      }

      if (page) await this.clearPageResources(page);
      if (browser) await browser.close();
      await fs.promises.unlink(tempHtmlPath);

      return framesDir.path;
    } catch (error) {
      logger.error("Failed to capture map frames:", {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
      });
      throw error;
    } finally {
      if (page) await this.clearPageResources(page);
      if (browser) await browser.close();
    }
  }

  /**
   * Creates a video from captured frames.
   * @param {string} framesDir - Directory containing frame files
   * @returns {Promise<string>} Path to generated video file
   */
  public async createVideo(framesDir: string): Promise<string> {
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
            "slow", // Better quality encoding
            "-crf",
            "18", // High quality (lower number = higher quality, 18-28 is good range)
            "-r",
            "24", // Match input FPS
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "high", // High profile for better quality
            "-level",
            "4.0", // Compatibility level
            "-movflags",
            "+faststart", // Enable streaming
            "-t",
            "3", // 3 second duration
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
            // Cleanup frames after successful video creation
            await this.cleanupFrames(framesDir);
            logger.info("Map video created successfully", {
              outputPath: outputPath.path,
            });
            resolve(outputPath.path);
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
    return mapVideoCacheService.getOrGenerate(
      coordinates,
      async () => {
        return retryService.withRetry(
          async () => {
            const framesDir = await this.captureMapFrames(coordinates);
            return this.createVideo(framesDir);
          },
          {
            jobId,
            maxRetries: 3,
            delays: [2000, 5000, 10000],
          }
        );
      },
      jobId
    );
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
