import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import {
  AppLogger,
  ErrorReporter,
  requestContextMiddleware,
} from './common/observability';
import { appConfig } from './config/app.config';
import { securityHeaders } from './common/rate-limit';

type AppConfig = ReturnType<typeof appConfig>;

async function bootstrap() {
  const appLogger = new AppLogger();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(appLogger);
  // Request id + access log first, so every later log line carries the id (msfts §10).
  app.use(requestContextMiddleware(appLogger));
  const configService = app.get<ConfigService<AppConfig, true>>(ConfigService);
  const logger = new Logger('Bootstrap');
  const apiPrefix = configService.get('app.apiPrefix', { infer: true });
  const port = configService.get('app.port', { infer: true });
  const swaggerEnabled = configService.get('app.swaggerEnabled', {
    infer: true,
  });

  app.setGlobalPrefix(apiPrefix);

  // Security headers (msfts §8) and no framework fingerprint.
  (
    app.getHttpAdapter().getInstance() as { disable: (k: string) => void }
  ).disable('x-powered-by');
  app.use(securityHeaders);

  // Behind a reverse proxy set TRUST_PROXY (e.g. `1` or `loopback`) so audit logs record the
  // client IP from X-Forwarded-For instead of the proxy's.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    const value = /^\d+$/.test(trustProxy)
      ? Number(trustProxy)
      : trustProxy === 'true'
        ? true
        : trustProxy;
    (
      app.getHttpAdapter().getInstance() as {
        set: (k: string, v: unknown) => void;
      }
    ).set('trust proxy', value);
  }

  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : ['http://localhost:3033', 'http://127.0.0.1:3033'];

  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Token-Transport',
      'X-Request-Id',
      'Idempotency-Key',
    ],
    exposedHeaders: ['Content-Disposition', 'Retry-After', 'X-Request-Id'],
    // The refresh token travels in an httpOnly cookie.
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
    ErrorReporter.capture(reason);
  });
  app.enableShutdownHooks();

  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle(configService.get('app.name', { infer: true }))
        .setDescription(
          'Backend API for the E-kimina platform built with NestJS, Prisma, and TypeScript.',
        )
        .setVersion(configService.get('app.version', { infer: true }))
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Paste a valid JWT access token.',
          },
          'JWT-auth',
        )
        // Do not add `.addServer('/api')` here: paths already include the global
        // prefix, and an extra server base would produce `/api/api/...` in Swagger UI.
        .build(),
    );

    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });
  }

  await app.listen(port);
  logger.log(`HTTP server listening on port ${port}`);
}

void bootstrap();
