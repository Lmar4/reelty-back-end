import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { RunwayML } from "@runwayml/sdk";
import axios from "axios";

interface ExternalServiceStatus {
  status: "online" | "offline";
  latency?: number;
  error?: string;
}

interface ServiceStatusResponse {
  runwayML: ExternalServiceStatus;
  googleMaps: ExternalServiceStatus;
  timestamp: string;
}

export async function getExternalServiceStatus(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const response: ServiceStatusResponse = {
    runwayML: { status: "offline" },
    googleMaps: { status: "offline" },
    timestamp: new Date().toISOString(),
  };

  const timeout = 5000; // 5 second timeout

  try {
    await checkRunwayML(response, timeout);
    await checkGoogleMaps(response, timeout);

    const statusCode = determineStatusCode(response);
    return {
      statusCode,
      body: JSON.stringify(response),
    };
  } catch (error) {
    console.error("Status check failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to check external services",
        timestamp: new Date().toISOString(),
      }),
    };
  }
}

// New helper function to check RunwayML status
const checkRunwayML = async (
  response: ServiceStatusResponse,
  timeout: number
): Promise<void> => {
  const runwayStart = Date.now();
  try {
    const runwayClient = new RunwayML({
      apiKey: process.env.RUNWAYML_API_KEY || "",
    });
    // Instead of using a non-existent `tasks.list()` method,
    // we perform a simple GET request to the API's base endpoint.
    // This assumes that a GET request to "/" is valid for checking
    // the service's health. Adjust the path if your API provides
    // a dedicated health check endpoint.
    await Promise.race([
      runwayClient.request({ method: "get", path: "/" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeout)
      ),
    ]);
    response.runwayML = {
      status: "online",
      latency: Date.now() - runwayStart,
    };
  } catch (error) {
    response.runwayML = {
      status: "offline",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

// New helper function to check Google Maps API status
const checkGoogleMaps = async (
  response: ServiceStatusResponse,
  timeout: number
) => {
  const mapsStart = Date.now();
  try {
    await Promise.race([
      axios.get(
        `https://maps.googleapis.com/maps/api/geocode/json?address=test&key=${process.env.GOOGLE_MAPS_API_KEY}`
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeout)
      ),
    ]);
    response.googleMaps = {
      status: "online",
      latency: Date.now() - mapsStart,
    };
  } catch (error) {
    response.googleMaps = {
      status: "offline",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
};

// New helper function to determine overall status code
const determineStatusCode = (response: ServiceStatusResponse): number => {
  return response.runwayML.status === "online" &&
    response.googleMaps.status === "online"
    ? 200
    : 503;
};
