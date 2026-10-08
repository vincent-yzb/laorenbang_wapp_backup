import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 全局前缀
  app.setGlobalPrefix('api');

  // 全局验证管道
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

  // CORS 配置
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  });

  // Swagger API 文档
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('老人帮 API')
      .setDescription('老人帮后端服务 API 文档')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('认证', '用户登录、注册相关接口')
      .addTag('用户', '用户信息管理')
      .addTag('老人管理', '老人信息管理')
      .addTag('天使', '天使入驻、管理相关接口')
      .addTag('订单', '订单管理相关接口')
      .addTag('支付', '支付、退款、提现相关接口')
      .addTag('消息', '消息通知相关接口')
      .addTag('位置服务', '位置相关接口')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3001;
  app.enableShutdownHooks();
  await app.listen(port, process.env.HOST || '0.0.0.0');

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🏠 老人帮后端服务已启动                                    ║
║                                                            ║
║   📍 服务地址: http://localhost:${port}                       ║
║   📖 API 文档: http://localhost:${port}/api/docs              ║
║                                                            ║
║   让关爱跨越山海 ❤️                                          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
}

bootstrap();
