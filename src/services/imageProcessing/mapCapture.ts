import puppeteer from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import ffmpeg from "fluent-ffmpeg";

const exists = promisify(fs.exists);
const mkdir = promisify(fs.mkdir);

interface Coordinates {
  lat: number;
  lng: number;
}

export class MapCapture {
  private outputDir: string;

  constructor(outputDir: string = "./temp") {
    this.outputDir = outputDir;
  }

  private async ensureDirectoryExists(dir: string): Promise<void> {
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
    }
  }

  async captureMapAnimation(
    address: string,
    coordinates?: Coordinates
  ): Promise<string[]> {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 768, height: 1280 });

      // Load Google Maps with the API key
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) {
        throw new Error("Google Maps API key is not configured");
      }

      // Create HTML content for the map
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Map Animation</title>
            <script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}"></script>
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

                // Add marker
                new google.maps.Marker({
                  position: location,
                  map: map,
                });

                // Start at zoom level 18 and zoom out
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

      // Write HTML to a temporary file
      const tempHtmlPath = path.join(this.outputDir, "map.html");
      await fs.promises.writeFile(tempHtmlPath, htmlContent);

      // Navigate to the local HTML file using absolute path
      const absoluteTempHtmlPath = path.resolve(tempHtmlPath);
      await page.goto(`file://${absoluteTempHtmlPath}`);
      await page.waitForFunction("typeof map !== 'undefined'");

      // Ensure output directory exists
      const framesDir = path.join(this.outputDir, "map_frames");
      await this.ensureDirectoryExists(framesDir);

      // Capture frames
      const frames: string[] = [];
      let frameCount = 0;
      let capturing = true;

      while (capturing && frameCount < 30) {
        const framePath = path.join(
          framesDir,
          `frame_${frameCount.toString().padStart(3, "0")}.jpg`
        );
        await page.screenshot({ path: framePath, type: "jpeg", quality: 90 });
        frames.push(framePath);
        frameCount++;

        const shouldContinue = await page.evaluate("window.captureFrame()");
        capturing = Boolean(shouldContinue);
        await new Promise((resolve) => setTimeout(resolve, 100)); // Small delay between frames
      }

      // Generate video from frames
      const outputPath = path.join(this.outputDir, `map_${Date.now()}.mp4`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(path.join(framesDir, "frame_%03d.jpg"))
          .inputFPS(10)
          .output(outputPath)
          .outputOptions(["-c:v libx264", "-pix_fmt yuv420p"])
          .on("end", () => resolve())
          .on("error", (err) =>
            reject(new Error(`FFmpeg error: ${err.message}`))
          )
          .run();
      });

      // Clean up frames
      await Promise.all(frames.map((frame) => fs.promises.unlink(frame)));
      await fs.promises.unlink(tempHtmlPath);

      return [outputPath];
    } finally {
      await browser.close();
    }
  }
}
