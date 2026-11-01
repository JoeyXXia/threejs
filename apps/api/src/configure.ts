import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
    } else {
      // Never expose Prisma errors, queries, connection strings or credential data.
      response.status(500).json({ message: 'Internal server error' });
    }
  }
}

export function configure(app: INestApplication) {
  app.useGlobalFilters(new SafeErrors());
  const origins = new Set((process.env.WEB_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(','));
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-requested-with'] !== 'WarehouseTwin' || (req.headers.origin && !origins.has(req.headers.origin))) {
        res.status(403).json({ message: 'Invalid request origin' });
        return;
      }
    }
    next();
  });
}
