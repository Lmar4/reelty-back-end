import puppeteer, { Browser, Page } from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { tempFileManager } from "../storage/temp-file.service";
import { logger } from "../../utils/logger";

// Declare types for Google Maps objects
declare global {
  var google: {
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
  var mapInstance: any;
}

export class MapCaptureService {
  private static instance: MapCaptureService;
  private googleMapsApiKey: string;
  private browser: Browser | null = null;

  private constructor() {
    this.googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || "";
    if (!this.googleMapsApiKey) {
      throw new Error("Google Maps API key is required");
    }
  }

  public static getInstance(): MapCaptureService {
    if (!MapCaptureService.instance) {
      MapCaptureService.instance = new MapCaptureService();
    }
    return MapCaptureService.instance;
  }

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

  public async captureMapFrames(coordinates: {
    lat: number;
    lng: number;
  }): Promise<string> {
    try {
      const framesDir = await tempFileManager.createDirectory("map-frames");
      const browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--window-size=1920,3413",
        ],
      });
      const page = await browser.newPage();
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

      // Load the HTML file
      await page.goto(`file://${tempHtmlPath}`);
      await page.waitForFunction("typeof mapInstance !== 'undefined'");

      // Wait for initial map load
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          if (
            typeof google !== "undefined" &&
            typeof mapInstance !== "undefined"
          ) {
            google.maps.event.addListenerOnce(mapInstance, "idle", () =>
              resolve()
            );
          } else {
            resolve();
          }
        });
      });

      // Reduced wait time for initial load
      await new Promise((resolve) => setTimeout(resolve, 1000));

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
        await page.evaluate(() => {
          return new Promise<void>((resolve) => {
            if (
              typeof google !== "undefined" &&
              typeof mapInstance !== "undefined"
            ) {
              google.maps.event.addListenerOnce(mapInstance, "idle", () =>
                resolve()
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

      await browser.close();
      await fs.promises.unlink(tempHtmlPath);

      return framesDir.path;
    } catch (error) {
      logger.error("Failed to capture map frames:", {
        error: error instanceof Error ? error.message : "Unknown error",
        coordinates,
      });
      throw error;
    }
  }

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
}

// Export singleton instance
export const mapCaptureService = MapCaptureService.getInstance();
