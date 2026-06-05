import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  let message: string;
  let name: string;
  let statusCode = 500;

  if (err instanceof Error) {
    message = err.message;
    name = err.name;
    const errWithStatus = err as Error & { status?: number };
    if (typeof errWithStatus.status === 'number') {
      statusCode = errWithStatus.status;
    }
  } else {
    message = 'Unknown error';
    name = 'server_error';
  }

  console.error('[Error]', message);

  if (res.headersSent) {
    return next(err);
  }

  const exposeMessage = statusCode < 500 || process.env.NODE_ENV !== 'production';

  res.status(statusCode).json({
    error: {
      message: exposeMessage ? message : 'Internal server error',
      type: name,
    },
  });
}
