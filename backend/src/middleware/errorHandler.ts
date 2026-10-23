import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.', request_id: req.id } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, [v.message]]));
    appError = new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', details);
  } else if (err?.type === 'entity.parse.failed') {
    appError = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  } else if (err?.code === 11000) {
    appError = new AppError(409, 'DUPLICATE', 'This record already exists.');
  } else {
    logger.error({ err, requestId: req.id }, 'Unhandled error');
    appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      request_id: req.id,
    },
  });
};
