import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';
import { ConfigService } from '../../config/config.service';

/**
 * 位置服务
 * 
 * 功能：
 * 1. 天使实时位置上报
 * 2. 子女端查看天使位置
 * 3. 服务轨迹记录
 * 4. 地址解析
 */
@Injectable()
export class LocationService {
  constructor(
    private prisma: PrismaService,
    private cacheService: CacheService,
    private configService: ConfigService,
  ) {}

  /**
   * 天使上报位置
   */
  async reportLocation(angelId: string, lat: number, lng: number) {
    // 更新数据库中的位置
    await this.prisma.angel.update({
      where: { id: angelId },
      data: { lat, lng },
    });

    // 更新缓存（实时位置，用于快速查询）
    await this.cacheService.setAngelLocation(angelId, lat, lng);

    // 查找进行中的订单，记录轨迹
    const activeOrders = await this.prisma.order.findMany({
      where: {
        angelId,
        status: { in: ['ON_WAY', 'ARRIVED', 'IN_PROGRESS'] },
      },
    });

    // 为每个进行中的订单记录位置轨迹
    for (const order of activeOrders) {
      await this.recordTrack(order.id, angelId, lat, lng);
    }

    return {
      success: true,
      message: '位置已更新',
    };
  }

  /**
   * 获取天使实时位置
   */
  async getAngelLocation(orderId: string, userId: string) {
    // 验证订单权限
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { angel: true },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    // 只有订单相关用户可以查看
    if (order.userId !== userId && order.elderlyId !== userId) {
      throw new ForbiddenException('无权查看');
    }

    if (!order.angelId) {
      return {
        success: true,
        data: null,
        message: '订单暂未分配天使',
      };
    }

    // 先从缓存获取
    let location = await this.cacheService.getAngelLocation(order.angelId);

    // 如果缓存没有，从数据库获取
    if (!location && order.angel) {
      location = {
        lat: order.angel.lat || 0,
        lng: order.angel.lng || 0,
        time: Date.now(),
      };
    }

    return {
      success: true,
      data: {
        angelId: order.angelId,
        angelName: order.angel?.name,
        ...location,
        // 计算距离
        distance: this.calculateDistance(
          order.lat || 0,
          order.lng || 0,
          location?.lat || 0,
          location?.lng || 0,
        ),
      },
    };
  }

  /**
   * 获取服务轨迹
   */
  async getTrack(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.userId !== userId && order.elderlyId !== userId && order.angelId !== userId) {
      throw new ForbiddenException('无权查看');
    }

    // TODO: 从轨迹表获取
    // 这里模拟返回轨迹数据
    return {
      success: true,
      data: {
        orderId,
        tracks: [
          { lat: 39.9042, lng: 116.4074, time: Date.now() - 3600000 },
          { lat: 39.9052, lng: 116.4084, time: Date.now() - 3000000 },
          { lat: 39.9062, lng: 116.4094, time: Date.now() - 2400000 },
          { lat: 39.9072, lng: 116.4104, time: Date.now() - 1800000 },
          { lat: 39.9082, lng: 116.4114, time: Date.now() - 1200000 },
        ],
      },
    };
  }

  /**
   * 地址解析（经纬度 -> 地址）
   */
  async reverseGeocode(lat: number, lng: number) {
    const amapKey = this.configService.amapKey;

    if (!amapKey) {
      return {
        success: true,
        data: { address: '未知地址（地图服务未配置）' },
      };
    }

    try {
      const url = `https://restapi.amap.com/v3/geocode/regeo?key=${amapKey}&location=${lng},${lat}`;
      const response = await fetch(url);
      const result = await response.json();

      if (result.status === '1' && result.regeocode) {
        return {
          success: true,
          data: {
            address: result.regeocode.formatted_address,
            province: result.regeocode.addressComponent?.province,
            city: result.regeocode.addressComponent?.city,
            district: result.regeocode.addressComponent?.district,
          },
        };
      }

      return {
        success: false,
        message: '地址解析失败',
      };
    } catch (error) {
      console.error('地址解析失败:', error);
      return {
        success: false,
        message: '地址解析服务异常',
      };
    }
  }

  /**
   * 地址搜索（地址 -> 经纬度）
   */
  async geocode(address: string, city?: string) {
    const amapKey = this.configService.amapKey;

    if (!amapKey) {
      return {
        success: false,
        message: '地图服务未配置',
      };
    }

    try {
      const cityParam = city ? `&city=${encodeURIComponent(city)}` : '';
      const url = `https://restapi.amap.com/v3/geocode/geo?key=${amapKey}&address=${encodeURIComponent(address)}${cityParam}`;
      const response = await fetch(url);
      const result = await response.json();

      if (result.status === '1' && result.geocodes && result.geocodes.length > 0) {
        const location = result.geocodes[0].location.split(',');
        return {
          success: true,
          data: {
            lng: parseFloat(location[0]),
            lat: parseFloat(location[1]),
            formattedAddress: result.geocodes[0].formatted_address,
          },
        };
      }

      return {
        success: false,
        message: '地址未找到',
      };
    } catch (error) {
      console.error('地址搜索失败:', error);
      return {
        success: false,
        message: '地址搜索服务异常',
      };
    }
  }

  /**
   * 计算两点距离
   */
  async calculateDistanceAPI(params: {
    fromLat: number;
    fromLng: number;
    toLat: number;
    toLng: number;
  }) {
    const { fromLat, fromLng, toLat, toLng } = params;
    const distance = this.calculateDistance(fromLat, fromLng, toLat, toLng);

    return {
      success: true,
      data: {
        distance,
        unit: 'km',
        walkTime: Math.round(distance / 5 * 60), // 步行时间（分钟），假设5km/h
        driveTime: Math.round(distance / 30 * 60), // 驾车时间（分钟），假设30km/h
      },
    };
  }

  // ============ 私有方法 ============

  /**
   * 记录轨迹
   */
  private async recordTrack(orderId: string, angelId: string, lat: number, lng: number) {
    // TODO: 保存到轨迹表
    // 为了不产生过多数据，可以设置最小间隔（如 30 秒）
    console.log(`[轨迹] 订单 ${orderId} 天使位置: ${lat}, ${lng}`);
  }

  /**
   * 计算两点距离（Haversine 公式）
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    if (!lat1 || !lng1 || !lat2 || !lng2) return 0;

    const R = 6371; // 地球半径（km）
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10;
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

