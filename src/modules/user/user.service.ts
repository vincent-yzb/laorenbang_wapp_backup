import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

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
}
