import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import ffmpeg from "fluent-ffmpeg";
import puppeteer, { Browser } from "puppeteer";
import { PassThrough } from "stream";
import { logger } from "../../utils/logger";

interface Coordinates {
  lat: number;
  lng: number;
}

interface Frame {
  buffer: Buffer;
  index: number;
}

export class MapCapture {
  private s3Client: S3Client;
  private readonly FALLBACK_MAP_KEY = "assets/maps/default_map_animation.mp4";
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000;

  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  private async getFallbackVideo(): Promise<string> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";
    try {
      // Check if fallback exists
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: this.FALLBACK_MAP_KEY,
      });

      await this.s3Client.send(command);
      const s3Url = `https://${bucket}.s3.${
        process.env.AWS_REGION || "us-east-2"
      }.amazonaws.com/${this.FALLBACK_MAP_KEY}`;
      logger.info("Using fallback map video", { s3Url });
      return s3Url;
    } catch (error) {
      logger.error("Failed to get fallback map video", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error(
        "No map video available - both generation and fallback failed"
      );
    }
  }

  private async streamToS3(
    stream: PassThrough,
    s3Key: string
  ): Promise<string> {
    const bucket = process.env.AWS_BUCKET || "reelty-prod-storage";

    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: bucket,
        Key: s3Key,
        Body: stream,
        ContentType: "video/mp4",
      },
    });

    await upload.done();
    return `https://${bucket}.s3.${
      process.env.AWS_REGION || "us-east-2"
    }.amazonaws.com/${s3Key}`;
  }

  private async launchBrowser(retryCount = 0): Promise<Browser> {
    try {
      return await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } catch (error) {
      if (retryCount < this.MAX_RETRIES) {
        logger.warn("Failed to launch browser, retrying", {
          error: error instanceof Error ? error.message : "Unknown error",
          attempt: retryCount + 1,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, this.RETRY_DELAY * Math.pow(2, retryCount))
        );
        return this.launchBrowser(retryCount + 1);
      }
      throw error;
    }
  }

  private async verifyGoogleMapsApiKey(): Promise<void> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error("Google Maps API key is not configured");
    }

    try {
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/staticmap?center=0,0&zoom=1&size=1x1&key=${apiKey}`
      );
      if (!response.ok) {
        throw new Error(`API key verification failed: ${response.statusText}`);
      }
    } catch (error) {
      logger.error("Google Maps API key verification failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error("Google Maps API is not accessible");
    }
  }

  async captureMapAnimation(
    address: string,
    coordinates?: Coordinates,
    jobId?: string
  ): Promise<string> {
    let browser: Browser | null = null;

    try {
      // Verify API key first
      await this.verifyGoogleMapsApiKey();

      browser = await this.launchBrowser();
      const frames: Frame[] = [];
      const outputStream = new PassThrough();

      const page = await browser.newPage();
      await page.setViewport({ width: 768, height: 1280 });

      // Rest of the HTML content and frame capture logic remains the same...
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Map Animation</title>
            <script src="https://maps.googleapis.com/maps/api/js?key=${
              process.env.GOOGLE_MAPS_API_KEY
            }"></script>
            <style>
              #map { height: 100vh; width: 100vw; }
              body { margin: 0; }
            </style>
          </head>
          <body>
            <div id="map"></div>
            <script>
              let map;
              async function initMap() {
                const location = ${
                  coordinates
                    ? `{ lat: ${coordinates.lat}, lng: ${coordinates.lng} }`
                    : `await geocodeAddress("${address}")`
                };
                
                map = new google.maps.Map(document.getElementById('map'), {
                  center: location,
                  zoom: 18,
                  mapTypeId: 'satellite',
                  tilt: 0,
                  disableDefaultUI: true
                });

                new google.maps.Marker({
                  position: location,
                  map: map,
                });

                map.setZoom(18);
                window.zoomLevel = 18;
              }

              async function geocodeAddress(address) {
                const geocoder = new google.maps.Geocoder();
                return new Promise((resolve, reject) => {
                  geocoder.geocode({ address }, (results, status) => {
                    if (status === 'OK') {
                      resolve(results[0].geometry.location.toJSON());
                    } else {
                      reject(new Error('Geocoding failed: ' + status));
                    }
                  });
                });
              }

              window.captureFrame = () => {
                if (window.zoomLevel > 14) {
                  map.setZoom(--window.zoomLevel);
                  return true;
                }
                return false;
              };

              initMap();
            </script>
          </body>
        </html>
      `;

      await page.setContent(htmlContent);
      await page.waitForFunction("typeof map !== 'undefined'");

      let frameCount = 0;
      let capturing = true;

      while (capturing && frameCount < 30) {
        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: 90,
        });

        frames.push({
          buffer: screenshot as Buffer,
          index: frameCount,
        });

        frameCount++;
        const shouldContinue = await page.evaluate("window.captureFrame()");
        capturing = Boolean(shouldContinue);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (frames.length < 5) {
        throw new Error("Not enough frames captured");
      }

      logger.info("Captured map frames", {
        frameCount,
        totalFrames: frames.length,
      });

      // Process frames with ffmpeg
      const ffmpegCommand = ffmpeg();

      frames.forEach((frame) => {
        const stream = new PassThrough();
        stream.end(frame.buffer);
        ffmpegCommand.input(stream);
      });

      ffmpegCommand
        .fps(10)
        .on("error", (err) => {
          logger.error("FFmpeg error:", err);
          outputStream.emit("error", err);
        })
        .on("end", () => {
          logger.info("FFmpeg processing completed");
          outputStream.end();
        })
        .outputOptions(["-c:v libx264", "-pix_fmt yuv420p"])
        .toFormat("mp4")
        .pipe(outputStream);

      const s3Key = `maps/${jobId || Date.now()}.mp4`;
      const s3Url = await this.streamToS3(outputStream, s3Key);

      logger.info("Map video uploaded", { s3Key, s3Url });
      return s3Url;
    } catch (error) {
      logger.error("Map capture failed, falling back to default", {
        error: error instanceof Error ? error.message : "Unknown error",
        address,
        coordinates,
      });

      try {
        return await this.getFallbackVideo();
      } catch (fallbackError) {
        logger.error("Both map capture and fallback failed", {
          originalError: error,
          fallbackError,
        });
        throw fallbackError;
      }
    } finally {
      if (browser) {
        await browser.close().catch((browserError: unknown) => {
          logger.warn("Failed to close browser", {
            error:
              browserError instanceof Error
                ? browserError.message
                : "Unknown error",
          });
        });
      }
    }
  }
}

export const mapCaptureService = new MapCapture();
