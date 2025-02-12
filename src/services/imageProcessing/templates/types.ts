export interface ReelTemplate {
  name: string;
  description: string;
  sequence: (number | string)[];
  durations: number[] | Record<string | number, number>;
  music?: {
    path: string;
    volume?: number;
    startTime?: number;
  };
  transitions?: {
    type: "crossfade" | "fade" | "slide";
    duration: number;
  }[];
}

export type TemplateKey =
  | "crescendo"
  | "wave"
  | "storyteller"
  | "googlezoomintro";

export const reelTemplates: Record<TemplateKey, ReelTemplate> = {
  crescendo: {
    name: "Crescendo",
    description:
      "A dynamic template that builds momentum with progressively longer clips",
    sequence: [0, 5, 9, 4, 7, 1, 3, 6, 8, 2], // Custom sequence
    durations: [
      2.0833,
      2.5,
      2.5417,
      2.9583,
      0.3333,
      0.3333,
      1.9167,
      2.5,
      2.5417,
      2.8333, // Original 24fps timings
    ],
    music: {
      path: "../../assets/music/upbeat.mp3",
      volume: 0.85,
    },
  },
  wave: {
    name: "Wave",
    description:
      "An engaging rhythm that alternates between quick glimpses and lingering views",
    sequence: [6, 2, 8, 1, 4, 9, 0, 3, 5, 7],
    durations: [3.0, 0.4, 0.33, 2.63, 0.73, 1.3, 1.3, 0.73, 3.57, 3.57],
    music: {
      path: "../../assets/music/smooth.mp3",
      volume: 0.8,
    },
  },
  storyteller: {
    name: "Storyteller",
    description:
      "A narrative-driven template that guides viewers through the property story",
    sequence: [3, 7, 1, 9, 0, 5, 2, 8, 4, 6],
    durations: [
      3.75, 3.6667, 3.625, 3.625, 3.625, 3.625, 3.625, 3.625, 3.625, 3.625,
    ],
    music: {
      path: "../../assets/music/minimal.mp3",
      volume: 0.75,
    },
  },
  googlezoomintro: {
    name: "Google Zoom Intro",
    description:
      "Start with a dramatic Google Maps zoom into the property location, followed by property highlights",
    sequence: ["map", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
    durations: {
      map: 3.0, // Map zoom video (3 seconds)
      0: 1.25,
      1: 0.9583,
      2: 0.9583,
      3: 0.625,
      4: 1.625,
      5: 1.875,
      6: 0.9167,
      7: 1.125,
      8: 1.0833,
      9: 1.9583,
    },
    music: {
      path: "../../assets/music/zoom.mp3",
      volume: 0.8,
    },
  },
} as const;
