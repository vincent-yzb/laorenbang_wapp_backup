import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';
import {
  CreateOrderDto,
  QueryOrderDto,
  NearbyOrdersDto,
  CancelOrderDto,
  RateOrderDto,
  CompleteServiceDto,
  OrderStatus,
} from './dto/order.dto';

@Injectable()
export class OrderService {
  constructor(
    private prisma: PrismaService,
    private cacheService: CacheService,
  ) {}

  /**
   * 生成订单号
   */
  private generateOrderNo(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString().slice(2, 6);
    return `${dateStr}${random}`;
  }

  /**
   * 创建订单
   */
  async create(userId: string, dto: CreateOrderDto) {
    console.log('[createOrder] 开始创建订单, userId:', userId);
    console.log('[createOrder] 请求数据:', JSON.stringify(dto));

    // 验证老人是否属于该用户
    console.log('[createOrder] 查询老人, elderlyId:', dto.elderlyId, 'userId:', userId);
    let elderly;
    try {
      elderly = await this.prisma.elderly.findFirst({
        where: { id: dto.elderlyId, userId },
      });
      console.log('[createOrder] 老人查询结果:', elderly ? elderly.id : 'null');
    } catch (err: any) {
      console.error('[createOrder] 老人查询失败:', err.message);
      throw new BadRequestException(`老人查询失败: ${err.message}`);
    }
    
    if (!elderly) {
      console.error('[createOrder] 老人信息无效');
      throw new BadRequestException('老人信息无效');
    }

    // 获取服务类型
    console.log('[createOrder] 查询服务类型, serviceTypeId:', dto.serviceTypeId);
    let serviceType;
    try {
      serviceType = await this.prisma.serviceType.findUnique({
        where: { id: dto.serviceTypeId },
      });
      console.log('[createOrder] 服务类型查询结果:', serviceType ? serviceType.name : 'null');
    } catch (err: any) {
      console.error('[createOrder] 服务类型查询失败:', err.message);
      throw new BadRequestException(`服务类型查询失败: ${err.message}`);
    }
    
    if (!serviceType) {
      console.error('[createOrder] 服务类型无效');
      throw new BadRequestException('服务类型无效');
    }

    // 创建订单
    console.log('[createOrder] 创建订单...');
    let order;
    try {
      order = await this.prisma.order.create({
        data: {
          orderNo: this.generateOrderNo(),
          status: 'PENDING',
          serviceTypeId: dto.serviceTypeId,
          serviceTime: new Date(dto.serviceTime),
          address: dto.address,
          lat: dto.lat,
          lng: dto.lng,
          remark: dto.remark,
          price: serviceType.price,
          userId,
          elderlyId: dto.elderlyId,
        },
        include: {
          serviceType: true,
          elderly: true,
        },
      });
      console.log('[createOrder] 订单创建成功, orderId:', order.id);
    } catch (err: any) {
      console.error('[createOrder] 订单创建失败:', err.message);
      throw new BadRequestException(`订单创建失败: ${err.message}`);
    }

    // 记录时间线
    try {
      await this.addTimeline(order.id, 'CREATE', '订单创建', '系统');
    } catch (err: any) {
      console.warn('[createOrder] 时间线记录失败:', err.message);
    }

    return {
      success: true,
      data: order,
    };
  }

  /**
   * 获取订单列表
   */
  async list(userId: string, userType: string, query: QueryOrderDto) {
    const { status, page = 1, pageSize = 10 } = query;
    const skip = (page - 1) * pageSize;

    // 构建查询条件
    let where: any = {};

    if (userType === 'child') {
      where.userId = userId;
    } else if (userType === 'angel') {
      where.angelId = userId;
    } else if (userType === 'elderly') {
      where.elderlyId = userId;
    }

    if (status) {
      where.status = status;
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          serviceType: true,
          elderly: true,
          angel: true,
          user: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      success: true,
      data: {
        list: orders,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * 获取附近订单（天使端）
   */
  async getNearbyOrders(angelId: string, dto: NearbyOrdersDto) {
    const { lat, lng, radius = 10 } = dto;

    // 简单的距离筛选（实际应使用 PostGIS 或专门的地理服务）
    // 这里使用简单的经纬度范围筛选
    const latRange = radius / 111; // 约111km/度
    const lngRange = radius / (111 * Math.cos((lat * Math.PI) / 180));

    // 服务后付款模式：订单创建时状态为 PENDING，也要展示给天使
    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PAID'] }, // 待接单的订单（服务后付款模式下是PENDING）
        angelId: null,
        // 如果订单有经纬度，则按距离筛选；如果没有，也显示出来让天使看到
        OR: [
          {
            lat: { gte: lat - latRange, lte: lat + latRange },
            lng: { gte: lng - lngRange, lte: lng + lngRange },
          },
          {
            lat: null,
          },
        ],
      },
      include: {
        serviceType: true,
        elderly: true,
        user: {
          select: { id: true, name: true, phone: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // 计算距离并排序
    const ordersWithDistance = orders.map(order => ({
      ...order,
      distance: this.calculateDistance(lat, lng, order.lat || 0, order.lng || 0),
    })).sort((a, b) => a.distance - b.distance);

    return {
      success: true,
      data: ordersWithDistance,
    };
  }

  /**
   * 获取订单详情
   */
  async getDetail(orderId: string, userId: string, userType: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        serviceType: true,
        elderly: true,
        angel: true,
        user: {
          select: { id: true, name: true, phone: true },
        },
        timelines: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    // 权限校验
    const hasAccess =
      order.userId === userId ||
      order.angelId === userId ||
      order.elderlyId === userId;

    if (!hasAccess) {
      throw new ForbiddenException('无权访问该订单');
    }

    return {
      success: true,
      data: order,
    };
  }

  /**
   * 天使接单
   */
  async accept(orderId: string, angelId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    // 服务后付款模式：PENDING 和 PAID 状态都可以接单
    if (!['PENDING', 'PAID'].includes(order.status)) {
      throw new BadRequestException('订单状态不允许接单');
    }

    if (order.angelId) {
      throw new BadRequestException('订单已被其他天使接单');
    }

    // 更新订单
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'ACCEPTED',
        angelId,
        acceptedAt: new Date(),
      },
      include: {
        serviceType: true,
        elderly: true,
      },
    });

    await this.addTimeline(orderId, 'ACCEPT', '天使已接单', '天使');

    // TODO: 发送通知给子女和老人

    return {
      success: true,
      message: '接单成功',
      data: updated,
    };
  }

  /**
   * 天使出发
   */
  async startDepart(orderId: string, angelId: string) {
    const order = await this.validateOrderOperation(orderId, angelId, 'ACCEPTED');

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'ON_WAY' },
    });

    await this.addTimeline(orderId, 'DEPART', '天使已出发', '天使');

    return { success: true, message: '已出发' };
  }

  /**
   * 天使到达
   */
  async arrive(orderId: string, angelId: string) {
    const order = await this.validateOrderOperation(orderId, angelId, 'ON_WAY');

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'ARRIVED',
        arrivedAt: new Date(),
      },
    });

    await this.addTimeline(orderId, 'ARRIVE', '天使已到达', '天使');

    return { success: true, message: '已确认到达' };
  }

  /**
   * 开始服务
   * 允许从 ACCEPTED、ON_WAY、ARRIVED 状态开始服务（灵活处理实际场景）
   */
  async startService(orderId: string, angelId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.angelId !== angelId) {
      throw new ForbiddenException('无权操作该订单');
    }

    // 允许从多个状态开始服务（实际场景中天使可能直接到达开始服务）
    const allowedStatuses = ['ACCEPTED', 'ON_WAY', 'ARRIVED'];
    if (!allowedStatuses.includes(order.status)) {
      throw new BadRequestException(`当前订单状态(${order.status})不允许开始服务`);
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        // 如果还没有到达时间，设置为现在
        arrivedAt: order.arrivedAt || new Date(),
      },
    });

    await this.addTimeline(orderId, 'START', '服务开始', '天使');

    return { success: true, message: '服务已开始' };
  }

  /**
   * 完成服务（天使端）
   */
  async completeService(orderId: string, angelId: string, dto: CompleteServiceDto) {
    const order = await this.validateOrderOperation(orderId, angelId, 'IN_PROGRESS');

    // 更新为待确认状态
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PENDING_CONFIRM',
        completedAt: new Date(),
      },
    });

    await this.addTimeline(orderId, 'COMPLETE_PENDING', '服务完成，等待确认', '天使');

    // TODO: 发送通知给子女确认

    return {
      success: true,
      message: '服务已完成，等待下单人确认',
    };
  }

  /**
   * 确认完成（子女端）
   */
  async confirmComplete(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.userId !== userId) {
      throw new ForbiddenException('无权操作该订单');
    }

    if (order.status !== 'PENDING_CONFIRM') {
      throw new BadRequestException('订单状态不允许确认');
    }

    // 更新订单状态
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED' },
    });

    // 给天使结算收入
    await this.settleAngelIncome(orderId);

    await this.addTimeline(orderId, 'CONFIRMED', '订单已确认完成', '子女');

    return { success: true, message: '订单已确认完成' };
  }

  /**
   * 取消订单
   */
  async cancel(orderId: string, userId: string, dto: CancelOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.userId !== userId) {
      throw new ForbiddenException('无权操作该订单');
    }

    // 只有待支付、已支付待接单状态可以取消
    if (!['PENDING', 'PAID'].includes(order.status)) {
      throw new BadRequestException('当前状态不允许取消');
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: dto.reason,
      },
    });

    // 如果已支付，触发退款
    if (order.isPaid) {
      // TODO: 调用退款接口
    }

    await this.addTimeline(orderId, 'CANCEL', `订单取消：${dto.reason}`, '子女');

    return { success: true, message: '订单已取消' };
  }

  /**
   * 评价订单
   */
  async rate(orderId: string, userId: string, dto: RateOrderDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.userId !== userId) {
      throw new ForbiddenException('无权评价该订单');
    }

    if (order.status !== 'COMPLETED') {
      throw new BadRequestException('订单未完成，无法评价');
    }

    if (order.rating) {
      throw new BadRequestException('订单已评价');
    }

    // 更新订单评价
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        rating: dto.rating,
        comment: dto.comment,
      },
    });

    // 更新天使评分
    if (order.angelId) {
      await this.updateAngelRating(order.angelId);
    }

    await this.addTimeline(orderId, 'RATE', `评价：${dto.rating}星`, '子女');

    return { success: true, message: '评价成功' };
  }

  // ============ 私有方法 ============

  /**
   * 验证订单操作权限
   */
  private async validateOrderOperation(orderId: string, angelId: string, expectedStatus: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.angelId !== angelId) {
      throw new ForbiddenException('无权操作该订单');
    }

    if (order.status !== expectedStatus) {
      throw new BadRequestException('订单状态不允许此操作');
    }

    return order;
  }

  /**
   * 添加订单时间线
   */
  private async addTimeline(orderId: string, event: string, content: string, operator: string) {
    await this.prisma.orderTimeline.create({
      data: { orderId, event, content, operator },
    });
  }

  /**
   * 计算两点之间距离（km）
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // 地球半径（km）
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10; // 保留一位小数
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  /**
   * 结算天使收入
   */
  private async settleAngelIncome(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { angel: true },
    });

    if (!order || !order.angelId) return;

    // 计算天使收入（扣除平台佣金，假设20%）
    const commission = 0.2;
    const angelIncome = order.price * (1 - commission);

    // 记录收入
    await this.prisma.incomeRecord.create({
      data: {
        angelId: order.angelId,
        amount: angelIncome,
        type: '订单收入',
        description: `订单 ${order.orderNo} 收入`,
        orderId: order.id,
      },
    });

    // 更新天使余额和完成订单数
    await this.prisma.angel.update({
      where: { id: order.angelId },
      data: {
        balance: { increment: angelIncome },
        completedOrders: { increment: 1 },
      },
    });
  }

  /**
   * 更新天使评分
   */
  private async updateAngelRating(angelId: string) {
    const result = await this.prisma.order.aggregate({
      where: { angelId, rating: { not: null } },
      _avg: { rating: true },
    });

    if (result._avg.rating) {
      await this.prisma.angel.update({
        where: { id: angelId },
        data: { rating: result._avg.rating },
      });
    }
  }
}
