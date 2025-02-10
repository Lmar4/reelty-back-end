import { Page } from "puppeteer";
import puppeteer from "puppeteer";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { Loader } from "@googlemaps/js-api-loader";

// Import Google Maps types
/// <reference types="@types/google.maps" />

interface MapConfig {
  initialZoom: number;
  finalZoom: number;
  frameCount: number;
}

// Define Google Maps types
interface Window {
  google: typeof google;
  map: google.maps.Map;
  mapReady: boolean;
  initMap: () => void;
  onerror?: (
    msg: string,
    url: string,
    line: number,
    col: number,
    error: Error
  ) => boolean;
}

declare global {
  interface Window {
    google: typeof google;
    map: google.maps.Map;
    mapReady: boolean;
    initMap: () => void;
    onerror?: (
      msg: string,
      url: string,
      line: number,
      col: number,
      error: Error
    ) => boolean;
  }
}

export class MapCapture {
  private outputDir: string;
  private config: MapConfig;
  private mapStyles: google.maps.MapTypeStyle[];
  private loader: Loader;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    this.config = {
      initialZoom: 18,
      finalZoom: 12,
      frameCount: 30,
    };
    this.mapStyles = []; // Add your map styles here
    this.loader = new Loader({
      apiKey: process.env.GOOGLE_MAPS_API_KEY || "",
      version: "weekly",
    });
  }

  private async initMap(page: Page): Promise<void> {
    await page.setViewport({ width: 1080, height: 1080 });

    // Add console message handler
    page.on("console", (msg) => console.log("Browser console:", msg.text()));
    page.on("pageerror", (err) => console.error("Browser error:", err.message));

    // Add error handler for script loading errors
    await page.evaluateOnNewDocument(() => {
      const win = globalThis as unknown as Window;
      win.onerror = (
        msg: string,
        url: string,
        line: number,
        col: number,
        error: Error
      ): boolean => {
        console.error("Browser script error:", { msg, url, line, col });
        return false;
      };
    });

    // Load Google Maps JavaScript API with callback
    await page.evaluate(`
      let scriptLoaded = false;
      window.initMap = function() {
        console.log('initMap called');
        try {
          const map = new google.maps.Map(document.getElementById('map'), {
            center: { lat: 0, lng: 0 },
            zoom: 2,
            disableDefaultUI: true,
            styles: ${JSON.stringify(this.mapStyles)}
          });
          console.log('Map instance created');
          window.map = map;
          window.mapReady = true;
        } catch (error) {
          console.error('Map creation error:', error.message);
        }
      };

      // Add script load handlers
      const script = document.createElement('script');
      script.src = "https://maps.googleapis.com/maps/api/js?key=${
        process.env.GOOGLE_MAPS_API_KEY
      }&callback=initMap";
      script.async = true;
      script.onerror = function(error) {
        console.error('Script load error:', error);
      };
      script.onload = function() {
        console.log('Maps script loaded');
        scriptLoaded = true;
      };
      document.head.appendChild(script);
    `);

    try {
      // First wait for script to load
      await page.waitForFunction("window.google !== undefined", {
        timeout: 10000,
      });
      console.log("Google Maps script loaded successfully");

      // Then wait for map initialization
      await page.waitForFunction("window.mapReady === true", {
        timeout: 20000,
      });
      console.log("Map initialized successfully");
    } catch (error) {
      console.error("Map initialization failed:", error);
      if (error instanceof Error && error.message.includes("google")) {
        throw new Error(
          "Failed to load Google Maps API. Please check if Maps JavaScript API is enabled in Google Cloud Console."
        );
      } else {
        throw new Error(
          "Failed to initialize map. Check browser console for details."
        );
      }
    }
  }

  async captureMapAnimation(address: string): Promise<string[]> {
    console.log("Starting map capture for address:", address);
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox"],
    });

    try {
      const page = await browser.newPage();

      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              #map { height: 100vh; width: 100vw; }
            </style>
            <script src="https://maps.googleapis.com/maps/api/js?key=${process.env.GOOGLE_MAPS_API_KEY}&callback=initMap" async defer></script>
          </head>
          <body>
            <div id="map"></div>
          </body>
        </html>
      `);

      await this.initMap(page);

      // Geocode address
      const location = await page.evaluate((addr: string) => {
        return new Promise<{ lat: number; lng: number }>((resolve, reject) => {
          const geocoder = new google.maps.Geocoder();
          geocoder.geocode(
            { address: addr },
            (
              results: google.maps.GeocoderResult[] | null,
              status: google.maps.GeocoderStatus
            ) => {
              if (
                status === google.maps.GeocoderStatus.OK &&
                results &&
                results[0]
              ) {
                const loc = results[0].geometry.location;
                resolve({ lat: loc.lat(), lng: loc.lng() });
              } else {
                reject(new Error(`Geocoding failed: ${status}`));
              }
            }
          );
        });
      }, address);

      // Animate map
      await page.evaluate((coords: { lat: number; lng: number }) => {
        // @ts-expect-error: window.map is defined in the page context
        const map: google.maps.Map | undefined = window.map;
        if (map) {
          map.setCenter({ lat: coords.lat, lng: coords.lng });
          map.setZoom(18);
        }
      }, location);

      // Capture frames
      const frames: string[] = [];
      const outputDir = path.join(this.outputDir, Date.now().toString());
      await fs.promises.mkdir(outputDir, { recursive: true });

      // Take screenshot
      const framePath = path.join(outputDir, `frame_0.jpg`);
      await page.screenshot({
        path: framePath,
        type: "jpeg",
        quality: 80,
      });
      frames.push(framePath);

      return frames;
    } catch (error) {
      console.error("Error capturing map animation:", error);
      throw error;
    } finally {
      await browser.close();
    }
  }
}
