import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
  console.error('[Error]', err.message);

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;
  const exposeMessage = status < 500 || process.env.NODE_ENV !== 'production';
  res.status(status).json({
    error: {
      message: exposeMessage ? err.message : 'Internal server error',
      type: err.name ?? 'server_error',
    },
  });
}
