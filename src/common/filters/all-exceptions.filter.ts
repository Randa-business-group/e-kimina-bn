import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import {
  ErrorReporter,
  currentRequestId,
  requestContext,
} from '../observability';
import { PrismaClientExceptionFilter } from './prisma-client-exception.filter';

/**
 * Last line of defence (msfts §10): HTTP errors keep Nest's usual body; Prisma errors keep
 * their mapping; anything unexpected is logged with its stack, reported to Sentry and answered
 * with a 500 that carries the request id so support can find it.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');
  private readonly prisma = new PrismaClientExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url: string;
      user?: { id: string };
    }>();
    const requestId = currentRequestId();
    const where = {
      requestId,
      userId: req.user?.id,
      method: req.method,
      path: (req.originalUrl ?? req.url).split('?')[0],
    };

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const code = exception.code;
      if (!['P2002', 'P2003', 'P2025'].includes(code))
        ErrorReporter.capture(exception, where);
      return this.prisma.catch(exception, host);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status >= 500) {
        this.logger.error(
          `${where.method} ${where.path} → ${status}: ${exception.message}`,
          exception.stack,
        );
        ErrorReporter.capture(exception, where);
      }
      const body = exception.getResponse();
      res
        .status(status)
        .json(
          typeof body === 'string'
            ? { statusCode: status, message: body }
            : body,
        );
      return;
    }

    const err =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      `${where.method} ${where.path} → 500: ${err.message}`,
      err.stack,
    );
    ErrorReporter.capture(err, {
      ...where,
      userId: where.userId ?? requestContext.getStore()?.userId,
    });
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      error: 'Internal Server Error',
      message: `Something went wrong on our side.${requestId ? ` Reference: ${requestId}` : ''}`,
      requestId,
    });
  }
}
