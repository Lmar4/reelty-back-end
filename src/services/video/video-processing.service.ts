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
}

// Export singleton instance
export const videoProcessingService = VideoProcessingService.getInstance();
