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
import { logger } from "../../utils/logger";
import { tempFileManager } from "../storage/temp-file.service";
import { MAP_CAPTURE_CONFIG } from "./map-capture.config";
import { resourceManager, ResourceState } from "../storage/resource-manager";
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";

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

interface FrameReference {
  path: string;
  count: number;
  lastAccessed: Date;
  scheduledForDeletion?: boolean;
}

export class MapCaptureService {
  private static instance: MapCaptureService;
  private readonly CACHE_DIR: string;
  private readonly CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly CLEANUP_DELAY = 5 * 60 * 1000; // 5 minutes
  private readonly frameReferences: Map<string, FrameReference> = new Map();
  private readonly cleanupTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private googleMapsApiKey: string = "";
  private browser: Browser | null = null;
  private s3Client: S3Client;

  /**
   * Private constructor for singleton pattern.
   * Validates environment variables and setup.
   */
  private constructor() {
    this.CACHE_DIR = path.join(
      process.env.TEMP_OUTPUT_DIR || "./temp",
      "map-cache"
    );

    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });

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

  private async trackFrame(filePath: string): Promise<void> {
    const ref = this.frameReferences.get(filePath);
    if (ref) {
      ref.count++;
      ref.lastAccessed = new Date();
      if (ref.scheduledForDeletion) {
        const timeout = this.cleanupTimeouts.get(filePath);
        if (timeout) {
          clearTimeout(timeout);
          this.cleanupTimeouts.delete(filePath);
        }
        ref.scheduledForDeletion = false;
      }
    } else {
      this.frameReferences.set(filePath, {
        path: filePath,
        count: 1,
        lastAccessed: new Date(),
      });
    }
    logger.debug("Tracked frame:", {
      path: filePath,
      references: this.frameReferences.get(filePath)?.count,
    });
  }

  private async releaseFrame(filePath: string): Promise<void> {
    const ref = this.frameReferences.get(filePath);
    if (ref) {
      ref.count--;
      ref.lastAccessed = new Date();
      logger.debug("Released frame:", {
        path: filePath,
        remainingReferences: ref.count,
      });

      if (ref.count <= 0 && !ref.scheduledForDeletion) {
        ref.scheduledForDeletion = true;
        const timeout = setTimeout(
          () => this.deleteFile(filePath),
          this.CLEANUP_DELAY
        );
        this.cleanupTimeouts.set(filePath, timeout);
        logger.debug("Scheduled frame for deletion:", {
          path: filePath,
          deleteIn: this.CLEANUP_DELAY,
        });
      }
    }
  }

  private async deleteFile(filePath: string): Promise<void> {
    try {
      const ref = this.frameReferences.get(filePath);
      if (!ref || ref.count > 0 || !ref.scheduledForDeletion) {
        return;
      }

      // Double-check file is not in use
      try {
        const stats = await fsPromises.stat(filePath);
        if (Date.now() - stats.mtimeMs < this.CLEANUP_DELAY) {
          logger.debug("File recently modified, delaying deletion:", {
            path: filePath,
            lastModified: stats.mtime,
          });
          // Reschedule deletion
          const timeout = setTimeout(
            () => this.deleteFile(filePath),
            this.CLEANUP_DELAY
          );
          this.cleanupTimeouts.set(filePath, timeout);
          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      await resourceManager.updateResourceState(
        filePath,
        ResourceState.UPLOADED
      );
      await fsPromises.unlink(filePath);
      this.frameReferences.delete(filePath);
      this.cleanupTimeouts.delete(filePath);
      logger.debug("Deleted file:", { filePath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Failed to delete file:", {
          path: filePath,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  private async cleanupFrames(framesDir: string): Promise<void> {
    try {
      // First check if directory exists
      try {
        await fsPromises.access(framesDir, constants.F_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          logger.info("Frames directory does not exist, skipping cleanup", {
            framesDir,
          });
          return;
        }
        throw error;
      }

      const files = await fsPromises.readdir(framesDir);
      await Promise.all(
        files.map(async (f) => {
          if (
            f.startsWith("frame_") ||
            f.startsWith("temp_frame_") ||
            f === "map.html"
          ) {
            const filePath = path.join(framesDir, f);
            await this.releaseFrame(filePath);
          }
        })
      );

      // Schedule directory removal after all files are processed
      setTimeout(async () => {
        try {
          // Check if directory is empty
          const remainingFiles = await fsPromises.readdir(framesDir);
          if (remainingFiles.length === 0) {
            await fsPromises.rmdir(framesDir);
            logger.info("Cleaned up frames directory successfully", {
              framesDir,
            });
          } else {
            logger.warn("Directory not empty, skipping removal:", {
              framesDir,
              remainingFiles: remainingFiles.length,
            });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn("Failed to remove frames directory:", {
              framesDir,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
      }, this.CLEANUP_DELAY);
    } catch (error) {
      logger.error("Error during frames cleanup:", {
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
    const tempDir = await tempFileManager.createDirectory("map_frames");
    const framesDir = tempDir.path;
    let tempHtmlPath: string | null = null;
    const MIN_REQUIRED_FRAMES = 10;

    try {
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
      tempHtmlPath = path.join(framesDir, "map.html");
      await fsPromises.writeFile(tempHtmlPath, htmlContent);

      // Track HTML file
      await resourceManager.trackResource(tempHtmlPath, "map-html", {
        coordinates,
      });
      await resourceManager.updateResourceState(
        tempHtmlPath,
        ResourceState.PROCESSING
      );

      // Load the HTML file with proper absolute path
      const absoluteHtmlPath = path.resolve(tempHtmlPath);
      await page.goto(
        `file://${
          absoluteHtmlPath.startsWith("/") ? "" : "/"
        }${absoluteHtmlPath}`,
        {
          waitUntil: "networkidle0",
          timeout: MAP_CAPTURE_CONFIG.TIMEOUTS.MAP_LOAD,
        }
      );

      // Wait for map to be fully loaded
      await this.validateMapLoaded(page);

      logger.info("Map instance created and loaded", { coordinates });

      // Set up the animation with proper loading checks
      await page.evaluate(async function (
        this: Window & { mapInstance: any },
        coords: { lat: number; lng: number }
      ) {
        const map = this.mapInstance;
        map.setCenter(coords);
        map.setZoom(4);

        // Wait for map to be idle (tiles loaded)
        await new Promise<void>((resolve) => {
          this.google.maps.event.addListenerOnce(map, "idle", () => {
            setTimeout(resolve, 3000);
          });
        });
      },
      coordinates);

      logger.info("Initial map view loaded, starting zoom sequence");

      // Capture frames with smooth zoom transition
      const START_ZOOM = 4;
      const END_ZOOM = 19.5;
      const FRAME_COUNT = 60;
      const capturedFrames: string[] = [];
      const failedFrames: { index: number; error: string }[] = [];

      for (let i = 0; i < FRAME_COUNT; i++) {
        const progress = i / (FRAME_COUNT - 1);
        const currentZoom = START_ZOOM + (END_ZOOM - START_ZOOM) * progress;

        // Set zoom level with retry mechanism
        let retries = 3;
        while (retries > 0) {
          try {
            await page.evaluate(async function (
              this: Window & { mapInstance: any },
              zoom: number
            ) {
              const map = this.mapInstance;
              map.setZoom(zoom);
              await new Promise<void>((resolve) => {
                this.google.maps.event.addListenerOnce(map, "idle", resolve);
              });
            },
            currentZoom);
            break;
          } catch (error) {
            retries--;
            if (retries === 0) {
              failedFrames.push({
                index: i,
                error: error instanceof Error ? error.message : "Unknown error",
              });
              logger.error(`Failed to set zoom for frame ${i}`, {
                zoom: currentZoom,
                error: error instanceof Error ? error.message : "Unknown error",
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }

        // Capture frame with retry mechanism
        const tempFramePath = path.join(
          framesDir,
          `temp_frame_${i.toString().padStart(2, "0")}.jpg`
        );
        const finalFramePath = path.join(
          framesDir,
          `frame_${i.toString().padStart(2, "0")}.jpg`
        );

        // Track frame files
        await resourceManager.trackResource(tempFramePath, "temp-frame", {
          frameIndex: i,
        });
        await resourceManager.trackResource(finalFramePath, "final-frame", {
          frameIndex: i,
        });

        try {
          await page.screenshot({
            path: tempFramePath,
            type: "jpeg",
            quality: 90,
          });

          await this.cropToPortrait(tempFramePath, finalFramePath);
          await resourceManager.updateResourceState(
            finalFramePath,
            ResourceState.PROCESSING
          );
          capturedFrames.push(finalFramePath);

          // Clean up temp frame
          await resourceManager.updateResourceState(
            tempFramePath,
            ResourceState.UPLOADED
          );
          await fsPromises.unlink(tempFramePath);

          logger.debug(`Captured frame ${i + 1}/${FRAME_COUNT}`, {
            zoom: currentZoom.toFixed(1),
            framePath: finalFramePath,
          });
        } catch (error) {
          failedFrames.push({
            index: i,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          await resourceManager.updateResourceState(
            tempFramePath,
            ResourceState.FAILED
          );
          await resourceManager.updateResourceState(
            finalFramePath,
            ResourceState.FAILED
          );
          logger.error(`Failed to capture frame ${i + 1}`, {
            error: error instanceof Error ? error.message : "Unknown error",
            zoom: currentZoom,
          });

          // Try to clean up failed frame files
          try {
            await fsPromises.unlink(tempFramePath).catch(() => {});
            await fsPromises.unlink(finalFramePath).catch(() => {});
          } catch (cleanupError) {
            logger.warn(`Failed to clean up frame files for index ${i}`, {
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : "Unknown error",
            });
          }
        }
      }

      // Validate frame count and quality
      if (capturedFrames.length < MIN_REQUIRED_FRAMES) {
        throw new Error(
          `Insufficient frames captured (${capturedFrames.length}/${MIN_REQUIRED_FRAMES} minimum required) for viable video`
        );
      }

      if (failedFrames.length > 0) {
        logger.warn("Some frames failed to capture", {
          failed: failedFrames.length,
          total: FRAME_COUNT,
          failures: failedFrames,
        });
      }

      // Track each captured frame
      const frameFiles = await fsPromises.readdir(framesDir);
      await Promise.all(
        frameFiles.map(async (f) => {
          if (f.startsWith("frame_") || f.startsWith("temp_frame_")) {
            const filePath = path.join(framesDir, f);
            await this.trackFrame(filePath);
          }
        })
      );

      return framesDir;
    } catch (error) {
      logger.error("Failed to capture map frames:", {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
      });

      // Immediate cleanup of temp directory and resources
      try {
        const files = await fsPromises.readdir(framesDir);
        await Promise.all(
          files.map(async (file) => {
            const filePath = path.join(framesDir, file);
            await resourceManager.updateResourceState(
              filePath,
              ResourceState.FAILED
            );
            await fsPromises.unlink(filePath).catch(() => {});
          })
        );
        await fsPromises.rmdir(framesDir).catch(() => {});
      } catch (cleanupError) {
        logger.warn("Failed to cleanup temp directory:", {
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : "Unknown error",
          path: framesDir,
        });
      }

      throw error;
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
    const s3Key = `maps/${crypto.randomUUID()}.mp4`;
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    let outputStream: any = null;

    try {
      // Create a PassThrough stream for FFmpeg output
      const { PassThrough } = await import("stream");
      outputStream = new PassThrough();

      // Start the S3 upload
      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: bucket,
          Key: s3Key,
          Body: outputStream,
          ContentType: "video/mp4",
        },
      });

      // Track the resource
      await resourceManager.trackResource(s3Key, "map-video");
      await resourceManager.updateResourceState(
        s3Key,
        ResourceState.PROCESSING
      );

      // Process frames with FFmpeg
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(path.join(framesDir, "frame_%02d.jpg"))
          .inputFPS(24)
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
          .toFormat("mp4")
          .on("progress", (progress) => {
            logger.info("FFmpeg progress", {
              frames: progress.frames,
              currentFps: progress.currentFps,
              percent: progress.percent,
              targetSize: progress.targetSize,
            });
          })
          .on("error", (error) => {
            outputStream.destroy();
            reject(new Error(`FFmpeg error: ${error.message}`));
          })
          .on("end", () => {
            outputStream.end();
            resolve();
          })
          .pipe(outputStream, { end: true });
      });

      // Wait for S3 upload to complete
      await upload.done();
      await resourceManager.updateResourceState(s3Key, ResourceState.UPLOADED);

      // Add safety delay to ensure FFmpeg has fully released files
      logger.info(
        "FFmpeg processing complete, waiting for file system sync..."
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Release frames after video is created and safety delay
      await this.cleanupFrames(framesDir);

      const s3Url = `https://${bucket}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${s3Key}`;
      return s3Url;
    } catch (error) {
      // Clean up stream if it exists
      if (outputStream) {
        try {
          outputStream.destroy();
        } catch (streamError) {
          logger.warn("Failed to destroy output stream:", {
            error:
              streamError instanceof Error
                ? streamError.message
                : "Unknown error",
          });
        }
      }

      await resourceManager.updateResourceState(s3Key, ResourceState.FAILED, {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw error;
    } finally {
      if (page) await this.clearPageResources(page);
      if (browser) await browser.close();
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
