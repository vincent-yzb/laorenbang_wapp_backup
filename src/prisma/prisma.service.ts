import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // 打印所有环境变量（调试用）
    console.log('🔍 All environment variables:');
    console.log(Object.keys(process.env).join(', '));
    
    const databaseUrl = process.env.DATABASE_URL;
    
    console.log('🔍 PrismaService initializing...');
    console.log('DATABASE_URL exists:', !!databaseUrl);
    
    if (!databaseUrl) {
      console.error('❌ DATABASE_URL is not set! Checking for Railway variables...');
      // Railway 有时用不同的变量名
      const railwayDbUrl = process.env.RAILWAY_DATABASE_URL || 
                           process.env.POSTGRES_URL ||
                           process.env.PGHOST ? `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}` : null;
      
      if (railwayDbUrl) {
        console.log('✅ Found alternative database URL');
      } else {
        throw new Error('DATABASE_URL environment variable is required. Set it in Railway Variables.');
      }
    }
    
    const finalDbUrl = databaseUrl || process.env.RAILWAY_DATABASE_URL || process.env.POSTGRES_URL;
    
    super({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
      datasources: {
        db: {
          url: finalDbUrl,
        },
      },
    });
    
    console.log('✅ PrismaClient initialized');
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

