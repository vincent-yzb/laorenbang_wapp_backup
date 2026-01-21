import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    
    console.log('🔍 Checking DATABASE_URL...');
    console.log('DATABASE_URL exists:', !!databaseUrl);
    console.log('DATABASE_URL length:', databaseUrl?.length || 0);
    
    if (!databaseUrl) {
      console.error('❌ DATABASE_URL is not set!');
      console.log('Available env vars:', Object.keys(process.env).filter(k => !k.includes('SECRET')));
    }
    
    super({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
      datasources: databaseUrl ? {
        db: {
          url: databaseUrl,
        },
      } : undefined,
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      console.log('✅ Database connected');
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

