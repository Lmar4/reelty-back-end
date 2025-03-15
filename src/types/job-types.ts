export interface JobProgress {
  stage: "webp" | "runway" | "template" | "final";
  progress: number;
  currentFile: number;
  totalFiles: number;
  estimatedTimeRemaining?: number;
}

export interface JobMetadata {
  stage: JobProgress["stage"];
  currentFile: number;
  totalFiles: number;
  estimatedTimeRemaining?: number;
  error?: string;
  retryCount?: number;
  startTime?: string;
  endTime?: string;
}
