import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AngelService {
  constructor(private prisma: PrismaService) {}

  /**
   * 天使入驻申请
   */
  async apply(phone: string, data: {
    name: string;
    idCard: string;
    idCardFront: string;
    idCardBack: string;
    avatar?: string;
  }) {
    // 检查是否已申请
    const existing = await this.prisma.angel.findUnique({
      where: { phone },
    });

    if (existing) {
      if (existing.status === 'APPROVED') {
        throw new BadRequestException('您已是认证天使');
      }
      if (existing.status === 'PENDING') {
        throw new BadRequestException('您的申请正在审核中');
      }
    }

    // 创建或更新申请
    const angel = await this.prisma.angel.upsert({
      where: { phone },
      create: {
        phone,
        name: data.name,
        idCard: data.idCard,
        idCardFront: data.idCardFront,
        idCardBack: data.idCardBack,
        avatar: data.avatar,
        status: 'PENDING',
      },
      update: {
        name: data.name,
        idCard: data.idCard,
        idCardFront: data.idCardFront,
        idCardBack: data.idCardBack,
        avatar: data.avatar,
        status: 'PENDING',
      },
    });

    return {
      success: true,
      message: '申请已提交，请等待审核',
      data: { id: angel.id, status: angel.status },
    };
  }

  /**
   * 获取申请状态
   */
  async getApplyStatus(angelId: string) {
    const angel = await this.prisma.angel.findUnique({
      where: { id: angelId },
    });

    if (!angel) {
      throw new NotFoundException('天使信息不存在');
    }

    return {
      success: true,
      data: {
        status: angel.status,
        isVerified: angel.isVerified,
      },
    };
  }

  /**
   * 获取天使信息
   */
  async getProfile(angelId: string) {
    const angel = await this.prisma.angel.findUnique({
      where: { id: angelId },
    });

    if (!angel) {
      throw new NotFoundException('天使信息不存在');
    }

    // 获取本月收入
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthlyIncome = await this.prisma.incomeRecord.aggregate({
      where: {
        angelId,
        type: '订单收入',
        createdAt: { gte: startOfMonth },
      },
      _sum: { amount: true },
    });

    return {
      success: true,
      data: {
        id: angel.id,
        phone: angel.phone,
        name: angel.name,
        avatar: angel.avatar,
        isVerified: angel.isVerified,
        status: angel.status,
        rating: angel.rating,
        completedOrders: angel.completedOrders,
        balance: angel.balance,
        monthlyIncome: monthlyIncome._sum.amount || 0,
        isOnline: angel.isOnline,
      },
    };
  }

  /**
   * 更新天使信息
   */
  async updateProfile(angelId: string, data: { name?: string; avatar?: string }) {
    const angel = await this.prisma.angel.update({
      where: { id: angelId },
      data,
    });

    return {
      success: true,
      data: angel,
    };
  }

  /**
   * 切换在线状态
   */
  async toggleOnline(angelId: string, isOnline: boolean) {
    const angel = await this.prisma.angel.findUnique({
      where: { id: angelId },
    });

    if (!angel) {
      throw new NotFoundException('天使信息不存在');
    }

    if (!angel.isVerified) {
      throw new BadRequestException('请先完成认证');
    }

    await this.prisma.angel.update({
      where: { id: angelId },
      data: { isOnline },
    });

    return {
      success: true,
      data: { isOnline },
      message: isOnline ? '已上线，开始接单' : '已下线',
    };
  }

  /**
   * 获取天使订单统计
   */
  async getOrderStats(angelId: string) {
    const stats = await this.prisma.order.groupBy({
      by: ['status'],
      where: { angelId },
      _count: true,
    });

    const result = {
      total: 0,
      pending: 0,     // 待服务
      inProgress: 0,  // 服务中
      completed: 0,   // 已完成
    };

    stats.forEach(item => {
      result.total += item._count;
      if (item.status === 'ACCEPTED') {
        result.pending += item._count;
      } else if (['ON_WAY', 'ARRIVED', 'IN_PROGRESS', 'PENDING_CONFIRM'].includes(item.status)) {
        result.inProgress += item._count;
      } else if (item.status === 'COMPLETED') {
        result.completed += item._count;
      }
    });

    // 获取今日开始时间
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 获取本月开始时间
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // 今日完成的订单数（而不是今日创建的）
    const todayOrders = await this.prisma.order.count({
      where: {
        angelId,
        status: 'COMPLETED',
        completedAt: { gte: today },
      },
    });

    // 获取今日收入
    const todayIncomeResult = await this.prisma.incomeRecord.aggregate({
      where: {
        angelId,
        type: '订单收入',
        createdAt: { gte: today },
      },
      _sum: { amount: true },
    });

    // 获取本月收入
    const monthIncomeResult = await this.prisma.incomeRecord.aggregate({
      where: {
        angelId,
        type: '订单收入',
        createdAt: { gte: startOfMonth },
      },
      _sum: { amount: true },
    });

    return {
      success: true,
      data: {
        ...result,
        todayOrders,
        // 同时返回两种命名，兼容前端
        todayIncome: todayIncomeResult._sum.amount || 0,
        todayEarnings: todayIncomeResult._sum.amount || 0,
        monthIncome: monthIncomeResult._sum.amount || 0,
        monthEarnings: monthIncomeResult._sum.amount || 0,
      },
    };
  }

  /**
   * 获取天使评价列表
   */
  async getReviews(angelId: string, page = 1, pageSize = 10) {
    const skip = (page - 1) * pageSize;

    const [reviews, total] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          angelId,
          rating: { not: null },
        },
        select: {
          id: true,
          orderNo: true,
          rating: true,
          comment: true,
          completedAt: true,
          serviceType: { select: { name: true } },
          user: { select: { name: true, avatar: true } },
        },
        orderBy: { completedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.order.count({
        where: { angelId, rating: { not: null } },
      }),
    ]);

    return {
      success: true,
      data: {
        list: reviews,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }
}
