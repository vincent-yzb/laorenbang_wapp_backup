import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';
import { CreateOrderDto, QueryOrderDto, NearbyOrdersDto, CancelOrderDto, RateOrderDto, CompleteServiceDto } from './dto/order.dto';
import { settleOrderIncome, validateMoney, moneyToCents } from './order-settlement';

const relatedUser = { select: { id: true, name: true, phone: true, avatar: true } };
const relatedAngel = { select: { id: true, name: true, phone: true, avatar: true, rating: true, lat: true, lng: true } };
const relatedElderly = { select: { id: true, name: true, phone: true, address: true, relation: true, avatar: true, healthNote: true, angelNote: true, lat: true, lng: true } };
const previewSelection = {
  id: true, orderNo: true, status: true, isPaid: true, price: true, serviceTime: true, lat: true, lng: true,
  serviceType: { select: { id: true, name: true, icon: true, description: true, unit: true, duration: true, category: true } },
} satisfies Prisma.OrderSelect;
type PreviewOrder = Prisma.OrderGetPayload<{ select: typeof previewSelection }>;

@Injectable()
export class OrderService {
  constructor(private prisma: PrismaService, private cacheService: CacheService) {}

  private generateOrderNo(): string {
    return `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomBytes(8).toString('hex')}`;
  }

  async create(userId: string, dto: CreateOrderDto) {
    if (dto.price !== undefined) validateMoney(dto.price);
    const serviceTime = new Date(dto.serviceTime);
    if (!Number.isFinite(serviceTime.getTime())) throw new BadRequestException('服务时间无效');
    const order = await this.prisma.$transaction(async tx => {
      const elderly = await tx.elderly.findFirst({ where: { id: dto.elderlyId, userId } });
      if (!elderly) throw new BadRequestException('老人信息无效');
      const serviceType = await tx.serviceType.findUnique({ where: { id: dto.serviceTypeId } });
      if (!serviceType?.isActive) throw new BadRequestException('服务类型无效或已停用');
      // Only the canonical custom service accepts a customer quote.
      const price = serviceType.id === 'custom' ? dto.price : serviceType.price;
      if (price === undefined) throw new BadRequestException('请填写定制服务报价');
      validateMoney(price);
      const created = await tx.order.create({
        data: {
          orderNo: this.generateOrderNo(), status: 'PENDING', serviceTypeId: serviceType.id,
          serviceTime, address: dto.address, lat: dto.lat, lng: dto.lng, remark: dto.remark,
          price, priceCents: moneyToCents(price), userId, elderlyId: elderly.id,
        },
        include: { serviceType: true, elderly: relatedElderly },
      });
      await this.addTimeline(tx, created.id, 'CREATE', '订单创建，服务完成后付款', '子女');
      return created;
    });
    return { success: true, data: order };
  }

  async list(userId: string, userType: string, query: QueryOrderDto) {
    const { status, page = 1, pageSize = 10 } = query;
    this.validatePagination(page, pageSize);
    const where: Prisma.OrderWhereInput = {};
    if (userType === 'child') where.userId = userId;
    else if (userType === 'angel') where.angelId = userId;
    else if (userType === 'elderly') where.elderlyId = userId;
    else throw new ForbiddenException('用户角色无效');
    if (status) where.status = status;
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where, include: { serviceType: true, elderly: relatedElderly, angel: relatedAngel, user: relatedUser },
        orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { success: true, data: { list: orders, total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  async getNearbyOrders(angelId: string, dto: NearbyOrdersDto) {
    const { lat, lng, radius = 10 } = dto;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180 || !Number.isFinite(radius) || radius < 1 || radius > 50) {
      throw new BadRequestException('位置或范围无效');
    }
    await this.requireApprovedAngel(angelId);
    const latRange = radius / 111;
    const lngRange = radius / (111 * Math.max(Math.abs(Math.cos(lat * Math.PI / 180)), 0.001));
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PAID'] }, angelId: null,
        serviceTime: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        OR: [{ lat: { gte: lat - latRange, lte: lat + latRange }, lng: { gte: lng - lngRange, lte: lng + lngRange } }, { lat: null }],
      },
      select: previewSelection,
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    const nearby = orders.map(order => this.toPreview(order,
      order.lat == null || order.lng == null ? null : this.calculateDistance(lat, lng, order.lat, order.lng)))
      .filter(order => order.distance === null || order.distance <= radius)
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return { success: true, data: nearby };
  }

  async getDetail(orderId: string, userId: string, userType: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { serviceType: true, elderly: relatedElderly, angel: relatedAngel, user: relatedUser, timelines: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (userType === 'angel' && order.angelId === null && ['PENDING', 'PAID'].includes(order.status)) {
      await this.requireApprovedAngel(userId);
      if (order.serviceTime.getTime() < Date.now() - 30 * 60 * 1000) throw new BadRequestException('订单已过期');
      return { success: true, data: this.toPreview(order) };
    }
    const hasAccess = (userType === 'child' && order.userId === userId) ||
      (userType === 'angel' && order.angelId === userId) || (userType === 'elderly' && order.elderlyId === userId);
    if (!hasAccess) throw new ForbiddenException('无权访问该订单');
    return { success: true, data: order };
  }

  async accept(orderId: string, angelId: string) {
    const updated = await this.prisma.$transaction(async tx => {
      const angel = await tx.angel.findUnique({ where: { id: angelId }, select: { isVerified: true, status: true, isOnline: true } });
      if (!angel?.isVerified || angel.status !== 'APPROVED' || !angel.isOnline) {
        throw new ForbiddenException('请完成天使审核并上线后接单');
      }
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: { in: ['PENDING', 'PAID'] }, angelId: null, serviceTime: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
        data: { status: 'ACCEPTED', angelId, acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new BadRequestException('订单已被接单或状态已更新');
      await this.addTimeline(tx, orderId, 'ACCEPT', '天使已接单', '天使');
      return tx.order.findUnique({ where: { id: orderId }, include: { serviceType: true, elderly: relatedElderly } });
    });
    return { success: true, message: '接单成功', data: updated };
  }

  async startDepart(orderId: string, angelId: string) {
    await this.transition(orderId, angelId, ['ACCEPTED'], 'ON_WAY', {}, 'DEPART', '天使已出发');
    return { success: true, message: '已出发' };
  }

  async arrive(orderId: string, angelId: string) {
    await this.transition(orderId, angelId, ['ON_WAY'], 'ARRIVED', { arrivedAt: new Date() }, 'ARRIVE', '天使已到达');
    return { success: true, message: '已确认到达' };
  }

  async startService(orderId: string, angelId: string) {
    await this.transition(orderId, angelId, ['ARRIVED'], 'IN_PROGRESS', { startedAt: new Date() }, 'START', '服务开始');
    return { success: true, message: '服务已开始' };
  }

  async completeService(orderId: string, angelId: string, dto: CompleteServiceDto) {
    await this.transition(orderId, angelId, ['IN_PROGRESS'], 'PENDING_CONFIRM', { completedAt: new Date() }, 'COMPLETE_PENDING',
      dto.remark ? `服务完成：${dto.remark}` : '服务完成，等待下单人付款');
    return { success: true, message: '服务已完成，等待下单人付款' };
  }

  /** Compatibility for old prepaid orders; new orders complete in payment settlement. */
  async confirmComplete(orderId: string, userId: string) {
    await this.prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.userId !== userId) throw new ForbiddenException('无权操作该订单');
      if (!order.isPaid) throw new BadRequestException('订单未付款，请先完成付款');
      if (order.status === 'COMPLETED') return;
      if (order.status !== 'PENDING_CONFIRM') throw new BadRequestException('订单状态不允许确认');
      const claimed = await tx.order.updateMany({
        where: { id: orderId, userId, isPaid: true, status: 'PENDING_CONFIRM' },
        data: { status: 'COMPLETED', completedAt: order.completedAt ?? new Date() },
      });
      if (claimed.count !== 1) {
        const current = await tx.order.findUnique({ where: { id: orderId } });
        if (current?.status === 'COMPLETED' && current.isPaid && current.userId === userId) return;
        throw new BadRequestException('订单状态已更新，请刷新后重试');
      }
      await settleOrderIncome(tx, order);
      await this.addTimeline(tx, orderId, 'CONFIRMED', '订单已确认完成', '子女');
    });
    return { success: true, message: '订单已确认完成' };
  }

  async cancel(orderId: string, userId: string, dto: CancelOrderDto) {
    await this.prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.userId !== userId) throw new ForbiddenException('无权操作该订单');
      if (order.isPaid) throw new ServiceUnavailableException('退款通道尚未开通，已付款订单请联系客服取消');
      const updated = await tx.order.updateMany({
        where: { id: orderId, userId, status: 'PENDING', angelId: null, isPaid: false },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason },
      });
      if (updated.count !== 1) throw new BadRequestException('当前状态不允许取消');
      await this.addTimeline(tx, orderId, 'CANCEL', `订单取消：${dto.reason}`, '子女');
    });
    return { success: true, message: '订单已取消' };
  }

  async rate(orderId: string, userId: string, dto: RateOrderDto) {
    if (!Number.isFinite(dto.rating) || dto.rating < 1 || dto.rating > 5) throw new BadRequestException('评分应为1至5分');
    await this.prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.userId !== userId) throw new ForbiddenException('无权评价该订单');
      const updated = await tx.order.updateMany({
        where: { id: orderId, userId, status: 'COMPLETED', isPaid: true, rating: null },
        data: { rating: dto.rating, comment: dto.comment },
      });
      if (updated.count !== 1) throw new BadRequestException('订单未付款完成或已评价');
      if (order.angelId) {
        const result = await tx.order.aggregate({ where: { angelId: order.angelId, rating: { not: null } }, _avg: { rating: true } });
        if (result._avg.rating != null) await tx.angel.update({ where: { id: order.angelId }, data: { rating: result._avg.rating } });
      }
      await this.addTimeline(tx, orderId, 'RATE', `评价：${dto.rating}星`, '子女');
    });
    return { success: true, message: '评价成功' };
  }

  private async transition(orderId: string, angelId: string, from: string[], status: string, data: Prisma.OrderUpdateManyMutationInput,
    event: string, content: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.angelId !== angelId) throw new ForbiddenException('无权操作该订单');
      const changed = await tx.order.updateMany({
        where: { id: orderId, angelId, status: { in: from } },
        data: { ...data, status },
      });
      if (changed.count !== 1) throw new BadRequestException('订单状态已更新或不允许此操作');
      await this.addTimeline(tx, orderId, event, content, '天使');
    });
  }

  private async addTimeline(tx: Prisma.TransactionClient, orderId: string, event: string, content: string, operator: string) {
    await tx.orderTimeline.create({ data: { orderId, event, content, operator } });
  }

  private async requireApprovedAngel(angelId: string): Promise<void> {
    const angel = await this.prisma.angel.findUnique({ where: { id: angelId }, select: { isVerified: true, status: true } });
    if (!angel?.isVerified || angel.status !== 'APPROVED') throw new ForbiddenException('请完成天使审核后查看待接订单');
  }

  private toPreview(order: PreviewOrder, distance: number | null = null) {
    const service = order.serviceType;
    return {
      id: order.id, orderNo: order.orderNo, status: order.status, isPaid: order.isPaid,
      price: order.price, serviceTime: order.serviceTime, isPreview: true,
      address: '接单后查看详细地址',
      lat: order.lat == null ? null : Math.round(order.lat * 100) / 100,
      lng: order.lng == null ? null : Math.round(order.lng * 100) / 100,
      distance,
      serviceType: {
        id: service.id, name: service.name, icon: service.icon, description: service.description,
        unit: service.unit, duration: service.duration, category: service.category,
      },
    };
  }

  private validatePagination(page: number, pageSize: number) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('分页参数无效');
  }

  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (degrees: number) => degrees * Math.PI / 180;
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
    return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))) * 10) / 10;
  }
}
