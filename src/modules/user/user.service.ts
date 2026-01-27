import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '../../config/config.service';

@Injectable()
export class UserService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  /**
   * 获取用户信息
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        elderly: true,
        _count: { select: { orders: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    return {
      success: true,
      data: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        avatar: user.avatar,
        isVerified: user.isVerified,
        elderlyCount: user.elderly.length,
        orderCount: user._count.orders,
        createdAt: user.createdAt,
      },
    };
  }

  /**
   * 更新用户信息
   */
  async updateProfile(userId: string, data: { name?: string; avatar?: string }) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return {
      success: true,
      data: user,
    };
  }

  /**
   * 实名认证
   */
  async verifyIdentity(userId: string, data: {
    name: string;
    idCard: string;
    idCardFront?: string;
    idCardBack?: string;
  }) {
    // TODO: 调用第三方实名认证 API 验证身份证
    // 1. 身份证 OCR 识别
    // 2. 人脸核身

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: data.name,
        idCard: data.idCard, // 实际应加密存储
        isVerified: true,
      },
    });

    return {
      success: true,
      message: '实名认证成功',
      data: { isVerified: user.isVerified },
    };
  }

  /**
   * 获取用户订单统计
   */
  async getOrderStats(userId: string) {
    const stats = await this.prisma.order.groupBy({
      by: ['status'],
      where: { userId },
      _count: true,
    });

    const result = {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
    };

    stats.forEach(item => {
      result.total += item._count;
      if (item.status === 'PENDING' || item.status === 'PAID') {
        result.pending += item._count;
      } else if (['ACCEPTED', 'ON_WAY', 'ARRIVED', 'IN_PROGRESS', 'PENDING_CONFIRM'].includes(item.status)) {
        result.inProgress += item._count;
      } else if (item.status === 'COMPLETED') {
        result.completed += item._count;
      } else if (item.status === 'CANCELLED' || item.status === 'REFUNDED') {
        result.cancelled += item._count;
      }
    });

    return {
      success: true,
      data: result,
    };
  }

  /**
   * 绑定手机号（验证码方式）
   */
  async bindPhone(userId: string, phone: string, code: string) {
    // 验证手机号格式
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      throw new BadRequestException('手机号格式不正确');
    }

    // TODO: 验证验证码
    // 开发阶段暂时跳过验证码校验，实际应该验证 Redis 中存储的验证码
    if (code !== '123456' && code.length !== 6) {
      throw new BadRequestException('验证码错误');
    }

    // 检查手机号是否已被其他用户使用
    const existingUser = await this.prisma.user.findFirst({
      where: { 
        phone, 
        id: { not: userId },
        NOT: { phone: { startsWith: 'wx_' } } // 排除临时手机号
      },
    });

    if (existingUser) {
      throw new BadRequestException('该手机号已被其他用户绑定');
    }

    // 更新用户手机号
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { phone },
    });

    return {
      success: true,
      message: '手机号绑定成功',
      data: { phone: user.phone },
    };
  }

  /**
   * 绑定手机号（微信方式）
   */
  async bindWechatPhone(userId: string, code: string) {
    try {
      // 调用微信 API 获取手机号
      const phone = await this.getPhoneNumberFromWechat(code);

      if (!phone) {
        throw new BadRequestException('获取手机号失败');
      }

      // 检查手机号是否已被其他用户使用
      const existingUser = await this.prisma.user.findFirst({
        where: { 
          phone, 
          id: { not: userId },
          NOT: { phone: { startsWith: 'wx_' } }
        },
      });

      if (existingUser) {
        throw new BadRequestException('该手机号已被其他用户绑定');
      }

      // 更新用户手机号
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: { phone },
      });

      return {
        success: true,
        message: '手机号绑定成功',
        phone: user.phone,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      console.error('微信获取手机号失败:', error);
      throw new BadRequestException('获取手机号失败，请重试');
    }
  }

  /**
   * 从微信获取用户手机号
   */
  private async getPhoneNumberFromWechat(code: string): Promise<string | null> {
    const appId = this.configService.wechatAppId;
    const appSecret = this.configService.wechatAppSecret;

    if (!appId || !appSecret) {
      console.warn('微信小程序配置缺失');
      // 开发模式：返回模拟手机号
      return '13800138000';
    }

    try {
      // 1. 先获取 access_token
      const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
      const tokenRes = await fetch(tokenUrl);
      const tokenData = await tokenRes.json();

      if (!tokenData.access_token) {
        console.error('获取 access_token 失败:', tokenData);
        return null;
      }

      // 2. 获取手机号
      const phoneUrl = `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${tokenData.access_token}`;
      const phoneRes = await fetch(phoneUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const phoneData = await phoneRes.json();

      if (phoneData.errcode === 0 && phoneData.phone_info?.phoneNumber) {
        return phoneData.phone_info.phoneNumber;
      }

      console.error('获取手机号失败:', phoneData);
      return null;
    } catch (error) {
      console.error('微信 API 调用失败:', error);
      return null;
    }
  }
}
