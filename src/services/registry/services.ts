import { progressTracker } from "../video/progress-tracker.service";
import { runwayService } from "../video/runway.service";
import { videoTemplateService } from "../video/video-template.service";
import { videoProcessingService } from "../video/video-processing.service";
import { mapCaptureService } from "../map-capture/map-capture.service";
import { assetManager } from "../assets/asset-manager";

import { retryService } from "../retry/retry.service";
import { ServiceRegistry } from "./service.registry";
import { resourceManager } from "../video/resource-manager.service";

export function registerServices(): void {
  const registry = ServiceRegistry.getInstance();

  // Register services with their metadata
  registry.register(progressTracker, {
    name: "ProgressTrackerService",
    dependencies: [],
    description: "Tracks progress of video generation jobs",
  });

  registry.register(runwayService, {
    name: "RunwayService",
    dependencies: ["ProgressTrackerService"],
    description: "Handles video generation using Runway API",
  });

  registry.register(videoTemplateService, {
    name: "VideoTemplateService",
    dependencies: ["ProgressTrackerService"],
    description: "Manages video templates and their creation",
  });

  registry.register(videoProcessingService, {
    name: "VideoProcessingService",
    dependencies: ["ProgressTrackerService"],
    description: "Processes and manipulates video files",
  });

  registry.register(mapCaptureService, {
    name: "MapCaptureService",
    dependencies: [],
    description: "Generates map videos for locations",
  });

  registry.register(assetManager, {
    name: "AssetManager",
    dependencies: [],
    description: "Manages assets like music, watermarks, etc.",
  });

  registry.register(resourceManager, {
    name: "ResourceManager",
    dependencies: [],
    description: "Manages and tracks resources used in video generation",
  });

  registry.register(retryService, {
    name: "RetryService",
    dependencies: [],
    description: "Handles retry logic for failed operations",
  });
}
