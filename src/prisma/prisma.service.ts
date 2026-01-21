import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    
    console.log('🔍 PrismaService initializing...');
    console.log('DATABASE_URL exists:', !!databaseUrl);
    console.log('DATABASE_URL preview:', databaseUrl ? databaseUrl.substring(0, 40) + '...' : 'NOT SET');
    
    if (!databaseUrl) {
      console.error('❌ DATABASE_URL is not set!');
      console.error('Available env vars:', Object.keys(process.env).filter(k => 
        k.includes('DATABASE') || k.includes('DB') || k.includes('PG') || k.includes('POSTGRES')
      ));
      throw new Error('DATABASE_URL environment variable is required');
    }
    
    // 使用运行时的 DATABASE_URL 覆盖 schema 中的占位符
    super({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });
    
    console.log('✅ PrismaClient initialized with runtime DATABASE_URL');
  }

  async onModuleInit() {
    try {
      console.log('🔄 Connecting to database...');
      await this.$connect();
      console.log('✅ Database connected successfully!');
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

