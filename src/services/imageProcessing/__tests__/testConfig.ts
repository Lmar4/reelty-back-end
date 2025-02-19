import path from "path";
import type { TemplateKey } from "../templates/types";
import { v4 as uuidv4 } from "uuid";

export const TEST_CONFIG = {
  TEMP_DIR: path.join(__dirname, "test-temp"),
  FIXTURES_DIR: path.join(__dirname, "fixtures"),
  SAMPLE_VIDEOS: {
    RUNWAY: Array.from({ length: 10 }, (_, i) =>
      path.join(process.cwd(), "temp", "samples", `segment_${i}.mp4`)
    ),
  },
  COORDINATES: {
    NEW_YORK: { lat: 40.7128, lng: -74.006 },
    SAN_FRANCISCO: { lat: 37.7749, lng: -122.4194 },
  },
  TEST_JOB_ID: uuidv4(),
  TEST_USER_ID: uuidv4(),
  TEST_LISTING_ID: uuidv4(),
  TEMPLATES: {
    ALL: [
      "storyteller",
      "wesanderson",
      "hyperpop",
      "googlezoomintro",
    ] as TemplateKey[],
    BASIC: ["storyteller", "wesanderson", "hyperpop"] as TemplateKey[],
    MAP_REQUIRED: ["googlezoomintro"] as TemplateKey[],
  },
  MOCK_FILES: {
    INPUT: ["test1.jpg", "test2.jpg"],
    OUTPUT: {
      RUNWAY: "processed-video.mp4",
      TEMPLATE: "clip1.mp4",
      FINAL: "final.mp4",
    },
  },
  MOCK_URLS: {
    MAP_VIDEO: "https://cached-map-video.mp4",
    TEMPLATE: "https://template-video.mp4",
  },
} as const;
