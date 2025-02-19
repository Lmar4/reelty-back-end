import { describe, expect, it } from "@jest/globals";
import { TEST_CONFIG } from "./testConfig";

describe("Test Configuration Utilities", () => {
  describe("Directory Configuration", () => {
    it("should have valid temp directory", () => {
      expect(TEST_CONFIG.TEMP_DIR).toBeDefined();
      expect(typeof TEST_CONFIG.TEMP_DIR).toBe("string");
      expect(TEST_CONFIG.TEMP_DIR).toContain("temp");
    });

    it("should have valid fixtures directory", () => {
      expect(TEST_CONFIG.FIXTURES_DIR).toBeDefined();
      expect(typeof TEST_CONFIG.FIXTURES_DIR).toBe("string");
      expect(TEST_CONFIG.FIXTURES_DIR).toContain("fixtures");
    });
  });

  describe("Sample Videos Configuration", () => {
    it("should have valid sample videos array", () => {
      expect(TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY).toBeInstanceOf(Array);
      expect(TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY).toHaveLength(10);
      TEST_CONFIG.SAMPLE_VIDEOS.RUNWAY.forEach((path: string) => {
        expect(typeof path).toBe("string");
        expect(path).toContain("segment_");
        expect(path).toContain(".mp4");
      });
    });
  });

  describe("Coordinates Configuration", () => {
    it("should have valid New York coordinates", () => {
      expect(TEST_CONFIG.COORDINATES.NEW_YORK).toEqual({
        lat: 40.7128,
        lng: -74.006,
      });
    });

    it("should have valid San Francisco coordinates", () => {
      expect(TEST_CONFIG.COORDINATES.SAN_FRANCISCO).toEqual({
        lat: 37.7749,
        lng: -122.4194,
      });
    });
  });

  describe("Template Configuration", () => {
    it("should have valid template arrays", () => {
      expect(TEST_CONFIG.TEMPLATES.ALL).toBeInstanceOf(Array);
      expect(TEST_CONFIG.TEMPLATES.BASIC).toBeInstanceOf(Array);
      expect(TEST_CONFIG.TEMPLATES.MAP_REQUIRED).toBeInstanceOf(Array);
    });

    it("should have correct template categorization", () => {
      expect(TEST_CONFIG.TEMPLATES.ALL).toContain("storyteller");
      expect(TEST_CONFIG.TEMPLATES.BASIC).not.toContain("googlezoomintro");
      expect(TEST_CONFIG.TEMPLATES.MAP_REQUIRED).toContain("googlezoomintro");
    });

    it("should have non-empty template arrays", () => {
      expect(TEST_CONFIG.TEMPLATES.ALL.length).toBeGreaterThan(0);
      expect(TEST_CONFIG.TEMPLATES.BASIC.length).toBeGreaterThan(0);
      expect(TEST_CONFIG.TEMPLATES.MAP_REQUIRED.length).toBeGreaterThan(0);
    });
  });

  describe("Mock Files Configuration", () => {
    it("should have valid input files", () => {
      expect(TEST_CONFIG.MOCK_FILES.INPUT).toBeInstanceOf(Array);
      expect(TEST_CONFIG.MOCK_FILES.INPUT.length).toBeGreaterThan(0);
      TEST_CONFIG.MOCK_FILES.INPUT.forEach((file: string) => {
        expect(typeof file).toBe("string");
        expect(file).toMatch(/\.(jpg|jpeg|png)$/);
      });
    });

    it("should have valid output file configuration", () => {
      expect(TEST_CONFIG.MOCK_FILES.OUTPUT.RUNWAY).toBeDefined();
      expect(TEST_CONFIG.MOCK_FILES.OUTPUT.TEMPLATE).toBeDefined();
      expect(TEST_CONFIG.MOCK_FILES.OUTPUT.FINAL).toBeDefined();
      expect(TEST_CONFIG.MOCK_FILES.OUTPUT.RUNWAY).toContain(".mp4");
      expect(TEST_CONFIG.MOCK_FILES.OUTPUT.TEMPLATE).toContain(".mp4");
      expect(TEST_CONFIG.MOCK_FILES.OUTPUT.FINAL).toContain(".mp4");
    });
  });

  describe("Mock URLs Configuration", () => {
    it("should have valid mock URLs", () => {
      expect(TEST_CONFIG.MOCK_URLS.MAP_VIDEO).toBeDefined();
      expect(TEST_CONFIG.MOCK_URLS.TEMPLATE).toBeDefined();
      expect(TEST_CONFIG.MOCK_URLS.MAP_VIDEO).toContain("http");
      expect(TEST_CONFIG.MOCK_URLS.TEMPLATE).toContain("http");
    });
  });
});
