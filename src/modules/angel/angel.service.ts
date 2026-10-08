import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IdentityService } from '../auth/identity.service';
import { validateInput } from '../auth/validate-input';
import { UpdateProfileDto } from '../user/dto/user.dto';
import { ApplyAngelDto, ToggleOnlineDto } from './dto/angel.dto';

@Injectable()
export class AngelService {
  constructor(private prisma: PrismaService, private identityService: IdentityService) {}

  /**
   * 天使入驻申请
   */
  async apply(angelId: string, input: ApplyAngelDto) {
    const data = validateInput(ApplyAngelDto, input);
    const existing = await this.prisma.angel.findUnique({ where: { id: angelId } });
    if (!existing) throw new NotFoundException('天使信息不存在');
    if (existing.phone !== data.phone || existing.phone.startsWith('wx_')) {
      throw new BadRequestException('请先绑定申请使用的手机号');
    }
    if (existing.status === 'APPROVED') throw new BadRequestException('您已是认证天使');
    if (existing.status === 'PENDING' && existing.idCard) throw new BadRequestException('您的申请正在审核中');
    const angel = await this.prisma.angel.update({
      where: { id: angelId },
      data: {
        name: data.name, idCard: data.idCard, idCardFront: data.idCardFront,
        idCardBack: data.idCardBack, avatar: data.avatar, status: 'PENDING',
      },
    });
    return { success: true, message: '申请已提交，请等待审核', data: { id: angel.id, status: angel.status } };
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
  async updateProfile(angelId: string, input: UpdateProfileDto) {
    const data = validateInput(UpdateProfileDto, input);
    const angel = await this.prisma.angel.update({
      where: { id: angelId },
      data,
    });

    return {
      success: true,
      data: { id: angel.id, name: angel.name, avatar: angel.avatar, phone: angel.phone, isVerified: angel.isVerified },
    };
  }

  /**
   * 切换在线状态
   */
  async toggleOnline(angelId: string, isOnline: boolean) {
    validateInput(ToggleOnlineDto, { isOnline });
    const angel = await this.prisma.angel.findUnique({
      where: { id: angelId },
    });

    if (!angel) {
      throw new NotFoundException('天使信息不存在');
    }

    if (isOnline && (!angel.isVerified || angel.status !== 'APPROVED')) {
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

  async bindPhone(angelId: string, phone: string, code: string) {
    await this.identityService.consumePhoneCode(phone, code);
    return this.savePhone(angelId, phone);
  }

  async bindWechatPhone(angelId: string, code: string) {
    const phone = await this.identityService.getWechatPhone(code);
    const result = await this.savePhone(angelId, phone);
    return { ...result, phone: result.data.phone };
  }

  private async savePhone(angelId: string, phone: string) {
    const existing = await this.prisma.angel.findUnique({ where: { phone } });
    if (existing && existing.id !== angelId) throw new BadRequestException('该手机号已被其他账号绑定');
    try {
      const angel = await this.prisma.angel.update({ where: { id: angelId }, data: { phone } });
      return { success: true, message: '手机号绑定成功', data: { phone: angel.phone } };
    } catch (error) {
      if (error?.code === 'P2002') throw new BadRequestException('该手机号已被其他账号绑定');
      throw error;
    }
  }

}
