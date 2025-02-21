export interface ProcessedImageResult {
  originalPath: string;
  processedPath: string;
  status: "pending" | "processing" | "completed" | "error";
}

export interface VideoService {
  createJob(input: VideoJobInput): Promise<any>;
}

export interface VideoJobInput {
  userId: string;
  listingId: string;
  template?: string;
  inputFiles: string[];
  metadata?: Record<string, any>;
}
