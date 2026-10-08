import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { CreateElderlyDto, UpdateElderlyDto } from './dto/elderly.dto';
import { validateInput } from '../auth/validate-input';

@Injectable()
export class ElderlyService {
  constructor(private prisma: PrismaService) {}

  /**
   * 生成6位邀请码
   */
  private generateInviteCode(): string {
    // 3字节 = 6位十六进制字符
    return crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  /**
   * 添加老人
   */
  async create(userId: string, input: CreateElderlyDto) {
    const data = validateInput(CreateElderlyDto, input);
    // 检查手机号是否已存在
    const existing = await this.prisma.elderly.findFirst({
      where: { phone: data.phone, userId },
    });

    if (existing) {
      throw new BadRequestException('该手机号已添加');
    }

    // 生成唯一邀请码
    let inviteCode = this.generateInviteCode();
    while (await this.prisma.elderly.findUnique({ where: { inviteCode } })) {
      inviteCode = this.generateInviteCode();
    }

    const elderly = await this.prisma.elderly.create({
      data: {
        ...data,
        inviteCode,
        userId,
      },
    });

    return {
      success: true,
      data: elderly,
    };
  }

  /**
   * 获取老人列表
   */
  async list(userId: string) {
    const elderly = await this.prisma.elderly.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      data: elderly,
    };
  }

  /**
   * 获取老人详情
   */
  async getDetail(elderlyId: string, userId: string) {
    const elderly = await this.prisma.elderly.findUnique({
      where: { id: elderlyId },
    });

    if (!elderly) {
      throw new NotFoundException('老人信息不存在');
    }

    if (elderly.userId !== userId) {
      throw new ForbiddenException('无权访问');
    }

    // 获取相关订单统计
    const orderStats = await this.prisma.order.groupBy({
      by: ['status'],
      where: { elderlyId },
      _count: true,
    });

    let totalOrders = 0;
    let completedOrders = 0;
    orderStats.forEach(item => {
      totalOrders += item._count;
      if (item.status === 'COMPLETED') {
        completedOrders = item._count;
      }
    });

    return {
      success: true,
      data: {
        ...elderly,
        stats: {
          totalOrders,
          completedOrders,
        },
      },
    };
  }

  /**
   * 更新老人信息
   */
  async update(elderlyId: string, userId: string, input: UpdateElderlyDto) {
    const data = validateInput(UpdateElderlyDto, input);
    const elderly = await this.prisma.elderly.findUnique({
      where: { id: elderlyId },
    });

    if (!elderly) {
      throw new NotFoundException('老人信息不存在');
    }

    if (elderly.userId !== userId) {
      throw new ForbiddenException('无权操作');
    }

    const updated = await this.prisma.elderly.update({
      where: { id: elderlyId },
      data,
    });

    return {
      success: true,
      data: updated,
    };
  }

  /**
   * 删除老人
   */
  async delete(elderlyId: string, userId: string) {
    const elderly = await this.prisma.elderly.findUnique({
      where: { id: elderlyId },
    });

    if (!elderly) {
      throw new NotFoundException('老人信息不存在');
    }

    if (elderly.userId !== userId) {
      throw new ForbiddenException('无权操作');
    }

    // Order history keeps its elderly relation, including cancelled and completed orders.
    const relatedOrders = await this.prisma.order.count({ where: { elderlyId } });

    if (relatedOrders > 0) {
      throw new BadRequestException('该老人有关联订单记录，无法删除');
    }

    try {
      await this.prisma.elderly.delete({ where: { id: elderlyId } });
    } catch (error) {
      // An order created after the count is still protected by the database foreign key.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new BadRequestException('该老人有关联订单记录，无法删除');
      }
      throw error;
    }

    return {
      success: true,
      message: '删除成功',
    };
  }

  /**
   * 获取老人信息（通过邀请码，用于老人端登录后获取）
   */
  async getByInviteCode(inviteCode: string) {
    const elderly = await this.prisma.elderly.findUnique({
      where: { inviteCode },
      include: {
        user: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    if (!elderly) {
      throw new NotFoundException('邀请码无效');
    }

    return {
      success: true,
      data: {
        id: elderly.id,
        name: elderly.name,
        phone: elderly.phone,
        address: elderly.address,
        relation: elderly.relation,
        familyMember: elderly.user, // 子女信息
      },
    };
  }

  /**
   * 刷新邀请码
   */
  async refreshInviteCode(elderlyId: string, userId: string) {
    const elderly = await this.prisma.elderly.findUnique({
      where: { id: elderlyId },
    });

    if (!elderly) {
      throw new NotFoundException('老人信息不存在');
    }

    if (elderly.userId !== userId) {
      throw new ForbiddenException('无权操作');
    }

    // 生成新邀请码
    let inviteCode = this.generateInviteCode();
    while (await this.prisma.elderly.findUnique({ where: { inviteCode } })) {
      inviteCode = this.generateInviteCode();
    }

    await this.prisma.elderly.update({
      where: { id: elderlyId },
      data: { inviteCode },
    });

    return {
      success: true,
      data: { inviteCode },
    };
  }
}
