import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

/**
 * 缓存服务 - 基于内存实现（生产环境应替换为 Redis）
 * 
 * 注意：当前使用内存 Map 实现，重启后数据丢失
 * 生产环境建议：npm install ioredis 并替换实现
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private store = new Map<string, { value: string; expireAt: number | null }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    // 定期清理过期数据
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
    console.log('✅ Cache service initialized (In-Memory)');
  }

  async onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * 设置缓存
   * @param key 键
   * @param value 值
   * @param ttlSeconds 过期时间（秒）
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expireAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expireAt });
  }

  /**
   * 获取缓存
   */
  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    
    // 检查是否过期
    if (item.expireAt && item.expireAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    
    return item.value;
  }

  /**
   * 删除缓存
   */
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * 检查是否存在
   */
  async exists(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  /**
   * 设置过期时间
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    const item = this.store.get(key);
    if (item) {
      item.expireAt = Date.now() + ttlSeconds * 1000;
    }
  }

  /**
   * 清理过期数据
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (item.expireAt && item.expireAt < now) {
        this.store.delete(key);
      }
    }
  }

  // ============ 业务方法 ============

  /**
   * 存储验证码
   */
  async setVerificationCode(phone: string, code: string, ttl = 300): Promise<void> {
    await this.set(`sms:code:${phone}`, code, ttl);
  }

  /**
   * 获取验证码
   */
  async getVerificationCode(phone: string): Promise<string | null> {
    return this.get(`sms:code:${phone}`);
  }

  /**
   * 删除验证码
   */
  async deleteVerificationCode(phone: string): Promise<void> {
    await this.del(`sms:code:${phone}`);
  }

  /**
   * 检查发送频率（1分钟内只能发1次）
   */
  async checkSendLimit(phone: string): Promise<boolean> {
    const key = `sms:limit:${phone}`;
    const exists = await this.exists(key);
    if (exists) return false;
    await this.set(key, '1', 60);
    return true;
  }

  /**
   * 存储天使位置
   */
  async setAngelLocation(angelId: string, lat: number, lng: number): Promise<void> {
    await this.set(`angel:location:${angelId}`, JSON.stringify({ lat, lng, time: Date.now() }), 600);
  }

  /**
   * 获取天使位置
   */
  async getAngelLocation(angelId: string): Promise<{ lat: number; lng: number; time: number } | null> {
    const data = await this.get(`angel:location:${angelId}`);
    return data ? JSON.parse(data) : null;
  }
}

