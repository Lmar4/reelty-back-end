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
};
