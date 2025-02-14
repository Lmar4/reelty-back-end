import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as path from "path";

export interface VideoClip {
  path: string;
  duration: number;
}

export interface MusicConfig {
  path: string;
  volume?: number;
  startTime?: number;
}

export interface VideoProcessingOptions {
  music?: MusicConfig;
  reverse?: boolean;
}

export class VideoProcessingService {
  private static instance: VideoProcessingService;

  private constructor() {}

  public static getInstance(): VideoProcessingService {
    if (!VideoProcessingService.instance) {
      VideoProcessingService.instance = new VideoProcessingService();
    }
    return VideoProcessingService.instance;
  }

  public async stitchVideos(
    inputFiles: string[],
    durations: number[],
    outputPath: string,
    musicConfig?: MusicConfig
  ): Promise<void> {
    console.log("Starting video stitching with:", {
      videoCount: inputFiles.length,
      durations,
      outputPath,
      hasMusicTrack: !!musicConfig,
      reverse: false,
    });

    if (inputFiles.length === 0) {
      throw new Error("No input files provided");
    }

    if (inputFiles.length !== durations.length) {
      throw new Error("Number of input files must match number of durations");
    }

    const command = ffmpeg();

    // Add input videos
    inputFiles.forEach((file) => {
      command.input(file);
    });

    // Add music track if provided
    if (musicConfig) {
      command.input(path.join(__dirname, musicConfig.path));
    }

    // Build complex filter
    let filterComplex = "";
    const videoLabels: string[] = [];

    // Process each video
    inputFiles.forEach((_, i) => {
      const label = `v${i}`;
      filterComplex += `[${i}:v]setpts=PTS-STARTPTS,scale=768:1280:force_original_aspect_ratio=decrease,pad=768:1280:(ow-iw)/2:(oh-ih)/2,trim=duration=${durations[i]},setpts=PTS-STARTPTS[${label}];`;
      videoLabels.push(`[${label}]`);
    });

    // Concatenate videos
    filterComplex += `${videoLabels.join("")}concat=n=${
      inputFiles.length
    }:v=1:a=0[outv]`;

    // Process audio if music is provided
    if (musicConfig) {
      const totalDuration = durations.reduce((sum, d) => sum + d, 0);
      const audioIndex = inputFiles.length; // Audio input is after all videos
      const volume = musicConfig.volume || 0.8; // Default volume if not specified
      const startTime = musicConfig.startTime || 0;
      filterComplex += `;[${audioIndex}:a]asetpts=PTS-STARTPTS,atrim=start=${startTime}:duration=${totalDuration},volume=${volume}:eval=frame,afade=t=out:st=${
        totalDuration - 1
      }:d=1[outa]`;
    }

    command
      .complexFilter(filterComplex)
      .outputOptions("-c:v", "libx264")
      .outputOptions("-preset", "slow")
      .outputOptions("-crf", "18")
      .outputOptions("-r", "24")
      .outputOptions("-c:a", "aac")
      .outputOptions("-shortest");

    if (musicConfig) {
      command.outputOptions("-map", "[outv]").outputOptions("-map", "[outa]");
    } else {
      command.outputOptions("-map", "[outv]");
    }

    command.output(outputPath);

    try {
      await new Promise<void>((resolve, reject) => {
        command
          .on("start", (commandLine) => {
            console.log("FFmpeg started:", commandLine);
          })
          .on("error", (err, stdout, stderr) => {
            console.error("FFmpeg error:", err);
            reject(new Error(`FFmpeg error: ${err.message}`));
          })
          .on("end", () => {
            resolve();
          })
          .run();
      });
    } catch (error) {
      console.error("Error during video stitching:", error);
      throw error;
    }
  }

  public async batchProcessVideos(
    inputVideos: string[],
    outputPath: string,
    options: VideoProcessingOptions = {}
  ): Promise<void> {
    console.log("Starting batch video processing with:", {
      videoCount: inputVideos.length,
      outputPath,
      hasMusicTrack: !!options.music,
      reverse: options.reverse,
    });

    // Create a temporary directory for intermediate files
    const tempDir = path.join(
      process.env.TEMP_OUTPUT_DIR || "./temp",
      "batch_" + Date.now()
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    try {
      // Process videos in parallel batches
      const batchSize = 3; // Process 3 videos at a time
      const batches = [];

      for (let i = 0; i < inputVideos.length; i += batchSize) {
        const batch = inputVideos.slice(i, i + batchSize);
        batches.push(batch);
      }

      // Process each batch
      for (const [index, batch] of batches.entries()) {
        console.log(`Processing batch ${index + 1}/${batches.length}`);
        await Promise.all(
          batch.map(async (video, idx) => {
            const outputFile = path.join(tempDir, `processed_${idx}.mp4`);
            await this.stitchVideos(
              [video],
              [5], // Default duration
              outputFile,
              options.music
            );
            return outputFile;
          })
        );
      }

      // Get all processed videos
      const processedFiles = await fs.promises.readdir(tempDir);
      const processedPaths = processedFiles
        .filter((file) => file.startsWith("processed_"))
        .map((file) => path.join(tempDir, file))
        .sort((a, b) => {
          const aNum = parseInt(a.match(/processed_(\d+)\.mp4/)?.[1] || "0");
          const bNum = parseInt(b.match(/processed_(\d+)\.mp4/)?.[1] || "0");
          return aNum - bNum;
        });

      // Final concatenation of all processed videos
      await this.stitchVideos(
        processedPaths,
        processedPaths.map(() => 5), // Default duration for each segment
        outputPath,
        options.music
      );
    } finally {
      // Cleanup temporary files
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error("Error cleaning up temporary files:", error);
      }
    }
  }
}

// Export singleton instance
export const videoProcessingService = VideoProcessingService.getInstance();
