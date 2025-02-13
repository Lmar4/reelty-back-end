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
    videoFiles: string[],
    durations: number[],
    outputPath: string,
    music?: MusicConfig,
    reverse: boolean = false
  ): Promise<void> {
    console.log("Starting video stitching with:", {
      videoCount: videoFiles.length,
      durations,
      outputPath,
      hasMusicTrack: !!music,
      reverse,
    });

    return new Promise((resolve, reject) => {
      let command = ffmpeg();

      // Add input files
      videoFiles.forEach((file) => {
        command = command.input(file);
      });

      // Add music if provided
      if (music) {
        const musicPath = path.resolve(__dirname, music.path);
        if (fs.existsSync(musicPath)) {
          command = command.input(musicPath);
        } else {
          console.warn(`Music file not found: ${musicPath}`);
        }
      }

      // Build complex filter
      const filterComplex: string[] = [];

      // Add trim and scale filters for each video
      videoFiles.forEach((_, i) => {
        filterComplex.push(
          `[${i}:v]setpts=PTS-STARTPTS,scale=768:1280:force_original_aspect_ratio=decrease,` +
            `pad=768:1280:(ow-iw)/2:(oh-ih)/2,trim=duration=${durations[i]},` +
            `${reverse ? "reverse," : ""}setpts=PTS-STARTPTS[v${i}]`
        );
      });

      // Create concat inputs string
      const concatInputs = Array.from(
        { length: videoFiles.length },
        (_, i) => `[v${i}]`
      ).join("");

      // Add concat filter
      filterComplex.push(
        `${concatInputs}concat=n=${videoFiles.length}:v=1:a=0[concat]`
      );

      // Add watermark if provided
      if (music) {
        const opacity = 0.5;
        const totalDuration = durations.reduce((a, b) => a + b, 0);
        filterComplex.push(
          `[concat][${videoFiles.length}:v]overlay=W-w-10:H-h-10:enable='between(t,0,${totalDuration})':alpha=${opacity}[outv]`
        );
      } else {
        filterComplex.push(`[concat]copy[outv]`);
      }

      // Add audio filters if music is provided
      if (music) {
        const volume = music.volume || 0.5;
        const startTime = music.startTime || 0;
        const totalDuration = durations.reduce((a, b) => a + b, 0);
        const fadeStart = Math.max(0, totalDuration - 1);
        filterComplex.push(
          `[${videoFiles.length}:a]asetpts=PTS-STARTPTS,` +
            `atrim=start=${startTime}:duration=${totalDuration},` +
            `volume=${volume}:eval=frame,` +
            `afade=t=out:st=${fadeStart}:d=1[outa]`
        );
      }

      // Apply complex filter
      command = command.complexFilter(filterComplex);

      // Map outputs
      command = command.outputOptions(["-map", "[outv]"]);
      if (music) {
        command = command.outputOptions(["-map", "[outa]"]);
      }

      // Set output options
      command = command
        .outputOptions([
          "-c:v",
          "libx264",
          "-preset",
          "slow",
          "-crf",
          "18",
          "-r",
          "24",
          "-c:a",
          "aac",
          "-shortest",
        ])
        .output(outputPath);

      // Handle events
      command
        .on("start", (commandLine) => {
          console.log("FFmpeg started:", commandLine);
        })
        .on("progress", (progress) => {
          console.log("FFmpeg progress:", progress);
        })
        .on("end", () => {
          console.log("FFmpeg processing finished");
          resolve();
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          reject(new Error(`FFmpeg error: ${err.message}`));
        });

      // Run the command
      command.run();
    });
  }

  public async batchProcessVideos(
    inputVideos: string[],
    outputPath: string,
    options: {
      template?: string;
      music?: MusicConfig;
      reverse?: boolean;
    } = {}
  ): Promise<void> {
    console.log("Starting batch video processing with:", {
      videoCount: inputVideos.length,
      outputPath,
      hasTemplate: !!options.template,
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
              options.music,
              options.reverse
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
        options.music,
        options.reverse
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
