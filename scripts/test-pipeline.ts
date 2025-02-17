import { ProductionPipeline } from "../src/services/imageProcessing/productionPipeline";
import path from "path";

async function testPipeline() {
  try {
    const pipeline = new ProductionPipeline();
    const testImages = [
      "20231124_152550.jpg",
      "20231124_154240.jpg",
      "20231124_154329.jpg",
    ];

    const jobId = "test-" + Date.now();
    console.log("Starting test pipeline with job ID:", jobId);

    // Convert paths to absolute
    const inputFiles = testImages.map((img) =>
      path.resolve(__dirname, "../public/assets/testing_image", img)
    );

    console.log("Input files:", inputFiles);

    // Execute the pipeline
    const result = await pipeline.execute({
      jobId,
      inputFiles,
      template: "storyteller",
      coordinates: { lat: 0, lng: 0 },
    });

    console.log("Pipeline completed successfully:", result);
  } catch (error) {
    console.error("Pipeline failed:", error);
  }
}

// Run the test
testPipeline().catch(console.error);
