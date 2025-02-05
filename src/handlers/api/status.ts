import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { RunwayML } from '@runwayml/sdk';
import axios from 'axios';

interface ExternalServiceStatus {
  status: 'online' | 'offline';
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
    runwayML: { status: 'offline' },
    googleMaps: { status: 'offline' },
    timestamp: new Date().toISOString()
  };

  const timeout = 5000; // 5 second timeout

  try {
    // Check RunwayML
    const runwayStart = Date.now();
    try {
      const runwayClient = new RunwayML(process.env.RUNWAY_API_KEY || '');
      await Promise.race([
        runwayClient.getStatus(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), timeout)
        )
      ]);
      response.runwayML = {
        status: 'online',
        latency: Date.now() - runwayStart
      };
    } catch (error) {
      response.runwayML = {
        status: 'offline',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    // Check Google Maps API
    const mapsStart = Date.now();
    try {
      await Promise.race([
        axios.get(
          `https://maps.googleapis.com/maps/api/geocode/json?address=test&key=${process.env.GOOGLE_MAPS_API_KEY}`
        ),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), timeout)
        )
      ]);
      response.googleMaps = {
        status: 'online',
        latency: Date.now() - mapsStart
      };
    } catch (error) {
      response.googleMaps = {
        status: 'offline',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    // Determine overall status code
    const statusCode = 
      response.runwayML.status === 'online' && 
      response.googleMaps.status === 'online' 
        ? 200 
        : 503;

    return {
      statusCode,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Status check failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to check external services',
        timestamp: new Date().toISOString()
      })
    };
  }
}
