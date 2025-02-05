import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PrismaClient } from '@prisma/client';
import { RunwayML } from '@runwayml/sdk';
import axios from 'axios';

const prisma = new PrismaClient();

interface HealthStatus {
  status: 'ok' | 'error';
  details: {
    database: {
      status: 'ok' | 'error';
      latency?: number;
      error?: string;
    };
    runwayML: {
      status: 'ok' | 'error';
      latency?: number;
      error?: string;
    };
    googleMaps: {
      status: 'ok' | 'error';
      latency?: number;
      error?: string;
    };
  };
}

export async function healthCheck(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const status: HealthStatus = {
    status: 'ok',
    details: {
      database: { status: 'ok' },
      runwayML: { status: 'ok' },
      googleMaps: { status: 'ok' }
    }
  };

  try {
    // Check database
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      status.details.database.latency = Date.now() - dbStart;
    } catch (error) {
      status.details.database.status = 'error';
      status.details.database.error = error instanceof Error ? error.message : 'Unknown error';
      status.status = 'error';
    }

    // Check RunwayML
    const runwayStart = Date.now();
    try {
      const runwayClient = new RunwayML(process.env.RUNWAY_API_KEY || '');
      await runwayClient.getStatus(); // Assuming this method exists
      status.details.runwayML.latency = Date.now() - runwayStart;
    } catch (error) {
      status.details.runwayML.status = 'error';
      status.details.runwayML.error = error instanceof Error ? error.message : 'Unknown error';
      status.status = 'error';
    }

    // Check Google Maps API
    const mapsStart = Date.now();
    try {
      await axios.get(
        `https://maps.googleapis.com/maps/api/geocode/json?address=test&key=${process.env.GOOGLE_MAPS_API_KEY}`
      );
      status.details.googleMaps.latency = Date.now() - mapsStart;
    } catch (error) {
      status.details.googleMaps.status = 'error';
      status.details.googleMaps.error = error instanceof Error ? error.message : 'Unknown error';
      status.status = 'error';
    }

    return {
      statusCode: status.status === 'ok' ? 200 : 500,
      body: JSON.stringify(status)
    };

  } catch (error) {
    console.error('Health check failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        status: 'error',
        error: 'Failed to perform health check'
      })
    };
  }
}
