/**
 * Video Template Types
 *
 * Type definitions and configurations for video templates.
 * Defines the structure and options for different video templates
 * used in the video generation process.
 *
 * Template Features:
 * - Template identification
 * - Asset requirements
 * - Processing options
 * - Composition settings
 *
 * @module TemplateTypes
 */

/**
 * Available template keys for video generation
 */
export type TemplateKey =
  | "crescendo"
  | "wave"
  | "storyteller"
  | "googlezoomintro"
  | "wesanderson"
  | "hyperpop";

/**
 * Base configuration for all templates
 */
export interface TemplateConfig {
  /** Unique identifier for the template */
  key: TemplateKey;
  /** Required assets for template processing */
  requiredAssets: string[];
  /** Processing options specific to the template */
  options: Record<string, unknown>;
}

/**
 * Defines the structure of a video template
 */
export interface ReelTemplate {
  /** Display name of the template */
  name: string;
  /** Description of the template's style and purpose */
  description: string;
  /** Sequence of clip indices for composition */
  sequence: (number | string)[];
  /** Duration of each clip in seconds */
  durations: number[] | Record<string | number, number>;
  /** Whether individual clips should be played in reverse */
  reverseClips?: boolean;
  /** Music configuration for the template */
  music?: {
    /** Path to the music file */
    path: string;
    /** Volume level for the music (optional) */
    volume?: number;
    /** Start time offset in seconds (optional) */
    startTime?: number;
    /** Whether the music track is available and valid */
    isValid?: boolean;
  };
  /** Optional transition effects between clips */
  transitions?: {
    /** Type of transition effect */
    type: "crossfade" | "fade" | "slide";
    /** Duration of the transition in seconds */
    duration: number;
  }[];
  /** Optional color correction settings */
  colorCorrection?: {
    /** FFmpeg filter string for color grading */
    ffmpegFilter: string;
  };
  /** Access level required for this template */
  accessLevel: TemplateAccessLevel;

  timeout?: number; // Added: FFmpeg timeout in milliseconds
  maxRetries?: number; // Added: Maximum retry attempts
}

// Add new type for template access level
export type TemplateAccessLevel = "free" | "premium";

export const reelTemplates: Record<TemplateKey, ReelTemplate> = {
  crescendo: {
    name: "Crescendo",
    description:
      "A dynamic template that builds momentum with progressively longer clips",
    sequence: [
      4, 12, 7, 15, 2, 18, 9, 1, 16, 5, 13, 8, 19, 3, 11, 6, 14, 0, 17, 10,
    ],
    durations: [
      1.8, 1.8333, 2.7833, 1.4833, 1.9333, 2.3333, 2.2667, 2.75, 3.1167, 3.1,
    ],
    music: {
      path: "assets/music/crescendo.mp3",
      volume: 0.85,
    },
    accessLevel: "free",
    timeout: 120000, // 2 minutes
    maxRetries: 2,
  },
  wave: {
    name: "Wave",
    description:
      "An engaging rhythm that alternates between quick glimpses and lingering views",
    sequence: [
      7, 15, 3, 11, 8, 16, 4, 12, 1, 19, 6, 14, 2, 10, 17, 5, 13, 9, 0, 18,
    ],
    durations: [
      0.6667, 1.3333, 1.35, 1.3333, 1.3333, 1.3333, 0.7, 1.15, 1.4833, 0.6667,
    ],
    reverseClips: true,
    music: {
      path: "assets/music/wave.mp3",
      volume: 0.8,
    },
    accessLevel: "free",
    timeout: 120000, // 2 minutes
    maxRetries: 2,
  },
  storyteller: {
    name: "Storyteller",
    description:
      "A narrative-driven template that guides viewers through the property story",
    sequence: [
      2, 10, 15, 7, 12, 4, 18, 1, 9, 16, 5, 13, 3, 11, 8, 19, 6, 14, 0, 17,
    ],
    durations: [
      2.1167, 1.6, 1.2, 1.6333, 1.2, 1.6167, 2.8667, 2.8167, 2.7833, 2.8667,
    ],
    music: {
      path: "assets/music/storyteller.mp3",
      volume: 0.75,
    },
    accessLevel: "free",
    timeout: 120000, // 2 minutes
    maxRetries: 2,
  },
  googlezoomintro: {
    name: "Google Zoom Intro",
    description:
      "Start with a dramatic Google Maps zoom into the property location, followed by property highlights",
    sequence: [
      "map",
      "0",
      "8",
      "15",
      "3",
      "11",
      "6",
      "17",
      "4",
      "12",
      "9",
      "1",
      "14",
      "7",
      "19",
      "5",
      "13",
      "2",
      "10",
      "16",
      "18",
    ],
    durations: {
      map: 3.0,
      0: 1.6,
      1: 1.2,
      2: 1.6333,
      3: 1.2,
      4: 1.6167,
      5: 2.8667,
      6: 2.8167,
      7: 2.7833,
      8: 2.8667,
      9: 1.05,
    },
    music: {
      path: "assets/music/googlezoomintro.mp3",
      volume: 0.8,
    },
    accessLevel: "premium",
    timeout: 300000, // 5 minutes - accounts for map + multiple clips
    maxRetries: 3,
  },
  wesanderson: {
    name: "Wes Anderson",
    description:
      "Symmetrical compositions with nostalgic color grading inspired by Wes Anderson's distinctive style",
    sequence: [
      5, 13, 8, 16, 2, 10, 15, 3, 11, 7, 19, 4, 12, 0, 17, 6, 14, 1, 9, 18,
    ],
    durations: [1.75, 1.7667, 1.65, 1.65, 1.65, 2.25, 1.1, 1.7, 1.65, 1.6333],
    music: {
      path: "assets/music/wesanderson.mp3",
      volume: 0.75,
    },
    colorCorrection: {
      ffmpegFilter:
        "brightness=0.05:contrast=1.15:saturation=1.3:gamma=0.95,hue=h=5:s=1.2,colorbalance=rm=0.1:gm=-0.05:bm=-0.1,curves=master='0/0 0.2/0.15 0.5/0.55 0.8/0.85 1/1',unsharp=5:5:1.5:5:5:0.0",
    },
    accessLevel: "premium",
    timeout: 300000, // 5 minutes - longer due to pre-processing complexity
    maxRetries: 2,
  },
  hyperpop: {
    name: "Hyperpop",
    description:
      "Fast-paced, energetic cuts with rapid transitions and dynamic movement",
    sequence: [
      9, 17, 4, 12, 7, 15, 2, 10, 18, 5, 13, 1, 8, 16, 3, 11, 6, 14, 0, 19,
    ],
    durations: [
      2.4167, 0.35, 2.7333, 2.4333, 2.7333, 0.7, 0.6667, 0.7667, 1.3667, 0.6833,
    ],
    reverseClips: true,
    music: {
      path: "assets/music/hyperpop.mp3",
      volume: 0.9,
    },
    accessLevel: "premium",
    timeout: 120000, // 2 minutes
    maxRetries: 2,
  },
} as const;
