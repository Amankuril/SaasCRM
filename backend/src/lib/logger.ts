import pino from 'pino';
import { env, isProd, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? 'silent' : isProd ? 'info' : 'debug',
  // Never let credentials or tokens reach the logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
