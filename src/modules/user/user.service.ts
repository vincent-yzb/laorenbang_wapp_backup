import { Injectable, NotFoundException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IdentityService } from '../auth/identity.service';
import { UpdateProfileDto, VerifyIdentityDto } from './dto/user.dto';
import { validateInput } from '../auth/validate-input';

@Injectable()
export class UserService {
  constructor(
    private prisma: PrismaService,
    private identityService: IdentityService,
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
  async updateProfile(userId: string, input: UpdateProfileDto) {
    const data = validateInput(UpdateProfileDto, input);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return {
      success: true,
      data: { id: user.id, name: user.name, avatar: user.avatar, phone: user.phone, isVerified: user.isVerified },
    };
  }

  /**
   * 实名认证
   */
  async verifyIdentity(userId: string, input: VerifyIdentityDto) {
    validateInput(VerifyIdentityDto, input);
    // Submitting an ID card is not a successful identity verification.
    throw new ServiceUnavailableException('实名认证服务尚未接入，暂不能完成认证');
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

  /** Bind only after consuming a cached proof of phone ownership. */
  async bindPhone(userId: string, phone: string, code: string) {
    await this.identityService.consumePhoneCode(phone, code);
    return this.savePhone(userId, phone);
  }

  async bindWechatPhone(userId: string, code: string) {
    const phone = await this.identityService.getWechatPhone(code);
    const result = await this.savePhone(userId, phone);
    return { ...result, phone: result.data.phone };
  }

  private async savePhone(userId: string, phone: string) {
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing && existing.id !== userId) {
      throw new BadRequestException('该手机号已被其他用户绑定');
    }
    try {
      const user = await this.prisma.user.update({ where: { id: userId }, data: { phone } });
      return { success: true, message: '手机号绑定成功', data: { phone: user.phone } };
    } catch (error) {
      if (error?.code === 'P2002') throw new BadRequestException('该手机号已被其他用户绑定');
      throw error;
    }
  }
}
