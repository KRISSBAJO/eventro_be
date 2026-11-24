import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { config } from './config';
import { AppModule } from './app.module';

export async function createApp() {
  // rawBody: Stripe webhook signatures are checked against the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const doc = new DocumentBuilder()
    .setTitle('Eventro API')
    .setDescription('Events, seat maps, checkout, tickets, organizer tools and admin.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));
  return app;
}

async function bootstrap() {
  const app = await createApp();
  // Local development stays on 127.0.0.1; containers set HOST=0.0.0.0.
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(config.port, host);
  Logger.log(`Eventro API on http://${host}:${config.port}/api/v1 (docs at /docs)`, 'Bootstrap');
}

if (require.main === module) {
  bootstrap().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
