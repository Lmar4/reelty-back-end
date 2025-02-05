import { createLogger, format, transports } from 'winston';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const logger = createLogger({
  level: 'error',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'reelty-api' },
  transports: [
    new transports.Console(),
    new transports.File({ 
      filename: 'logs/error.log',
      level: 'error'
    })
  ]
});

export interface ErrorWithStatus extends Error {
  statusCode?: number;
}

export function errorLogger(
  error: ErrorWithStatus,
  event: APIGatewayProxyEvent
): APIGatewayProxyResult {
  const statusCode = error.statusCode || 500;
  
  logger.error('API Error:', {
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name
    },
    request: {
      path: event.path,
      method: event.httpMethod,
      queryParams: event.queryStringParameters,
      headers: event.headers,
      sourceIp: event.requestContext.identity.sourceIp,
      userAgent: event.requestContext.identity.userAgent
    }
  });

  return {
    statusCode,
    body: JSON.stringify({
      error: process.env.NODE_ENV === 'production' 
        ? 'Internal Server Error'
        : error.message
    })
  };
}
