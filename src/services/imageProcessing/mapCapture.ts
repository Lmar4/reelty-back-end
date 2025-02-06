import puppeteer from "puppeteer";
import * as fs from "fs/promises";
import * as path from "path";
import sharp from "sharp";

interface MapConfig {
  width: number;
  height: number;
  initialZoom: number;
  finalZoom: number;
  frameCount: number;
}

export class MapCapture {
  private outputDir: string;
  private config: MapConfig;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    // Configure for 9:16 aspect ratio
    this.config = {
      width: 1080,
      height: 1920,
      initialZoom: 18, // Street level
      finalZoom: 15, // Neighborhood level
      frameCount: 30, // Number of frames to capture
    };
  }

  private async injectGoogleMapsScript(page: puppeteer.Page): Promise<void> {
    await page.evaluate(`
      function initMap(address) {
        return new Promise((resolve, reject) => {
          const map = new google.maps.Map(document.getElementById('map'), {
            zoom: ${this.config.initialZoom},
            disableDefaultUI: true,
            gestureHandling: 'none'
          });
          
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode({ address }, (results, status) => {
            if (status === 'OK' && results[0]) {
              map.setCenter(results[0].geometry.location);
              resolve(true);
            } else {
              reject(new Error('Geocoding failed'));
            }
          });
        });
      }
    `);
  }

  private async setupPage(page: puppeteer.Page): Promise<void> {
    await page.setViewport({
      width: this.config.width,
      height: this.config.height,
      deviceScaleFactor: 1,
    });

    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            #map {
              height: 100vh;
              width: 100vw;
              margin: 0;
              padding: 0;
            }
            body {
              margin: 0;
              padding: 0;
            }
          </style>
          <script src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_API_KEY}"></script>
        </head>
        <body>
          <div id="map"></div>
        </body>
      </html>
    `);
  }

  private async processFrame(
    screenshot: Buffer,
    frameIndex: number
  ): Promise<string> {
    const outputPath = path.join(
      this.outputDir,
      `frame_${frameIndex.toString().padStart(3, "0")}.jpg`
    );

    await sharp(screenshot)
      .resize({
        width: this.config.width,
        height: this.config.height,
        fit: "cover",
        position: "center",
      })
      .jpeg({ quality: 90 })
      .toFile(outputPath);

    return outputPath;
  }

  async captureMapAnimation(address: string): Promise<string[]> {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    const frames: string[] = [];

    try {
      // Create output directory if it doesn't exist
      await fs.mkdir(this.outputDir, { recursive: true });

      // Setup the page with Google Maps
      await this.setupPage(page);
      await this.injectGoogleMapsScript(page);

      // Initialize map with address
      await page.evaluate(`initMap("${address}")`);
      await page.waitForTimeout(1000); // Wait for map to settle

      // Calculate zoom steps
      const zoomStep =
        (this.config.finalZoom - this.config.initialZoom) /
        this.config.frameCount;

      // Capture frames while zooming out
      for (let i = 0; i < this.config.frameCount; i++) {
        const currentZoom = this.config.initialZoom + zoomStep * i;

        await page.evaluate(`
          map.setZoom(${currentZoom});
        `);

        // Wait for map rendering
        await page.waitForTimeout(100);

        const screenshot = await page.screenshot({
          type: "jpeg",
          quality: 90,
        });

        const framePath = await this.processFrame(screenshot as Buffer, i);
        frames.push(framePath);
      }

      return frames;
    } catch (error) {
      console.error("Error capturing map animation:", error);
      throw new Error(
        `Failed to capture map animation: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      await browser.close();
    }
  }
}
