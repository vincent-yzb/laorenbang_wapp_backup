import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '../../config/config.service';

/**
 * 消息服务
 * 
 * 功能：
 * 1. 订阅消息（微信小程序模板消息）
 * 2. 系统消息（站内信）
 * 3. 订单消息（简易 IM）
 */
@Injectable()
export class MessageService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  // ============ 订阅消息 ============

  /**
   * 发送订阅消息（微信小程序）
   */
  async sendSubscribeMessage(params: {
    touser: string;       // 用户 openid
    templateId: string;   // 模板ID
    page?: string;        // 跳转页面
    data: Record<string, { value: string }>; // 模板数据
  }) {
    const { touser, templateId, page, data } = params;

    // 开发环境模拟
    if (this.configService.isDevelopment) {
      console.log('[订阅消息] 发送模拟消息:', { touser, templateId, data });
      return { success: true, message: '发送成功（开发模式）' };
    }

    // 获取 access_token
    const accessToken = await this.getAccessToken();

    try {
      const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser,
          template_id: templateId,
          page,
          data,
        }),
      });

      const result = await response.json();
      if (result.errcode === 0) {
        return { success: true, message: '发送成功' };
      } else {
        console.error('[订阅消息] 发送失败:', result);
        return { success: false, message: result.errmsg };
      }
    } catch (error) {
      console.error('[订阅消息] 发送异常:', error);
      return { success: false, message: '发送失败' };
    }
  }

  /**
   * 发送订单状态变更通知
   */
  async sendOrderStatusNotify(orderId: string, status: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, elderly: true, angel: true, serviceType: true },
    });

    if (!order) return;

    // 根据状态发送不同通知
    const statusMessages = {
      PAID: '您的订单已支付成功，正在等待天使接单',
      ACCEPTED: `天使 ${order.angel?.name || ''} 已接单，正在赶来`,
      ARRIVED: '天使已到达服务地址',
      IN_PROGRESS: '服务已开始',
      PENDING_CONFIRM: '服务已完成，请确认',
      COMPLETED: '订单已完成，感谢您的使用',
    };

    const message = statusMessages[status];
    if (!message) return;

    // TODO: 获取用户 openid 并发送订阅消息
    console.log(`[通知] 订单 ${order.orderNo} 状态变更: ${message}`);

    // 发送订阅消息
    // await this.sendSubscribeMessage({
    //   touser: order.user.openid,
    //   templateId: 'ORDER_STATUS_TEMPLATE_ID',
    //   page: `/pages/child/order-detail/index?id=${order.id}`,
    //   data: {
    //     thing1: { value: order.serviceType.name },
    //     phrase2: { value: status },
    //     thing3: { value: message },
    //   },
    // });
  }

  /**
   * 发送紧急求助通知
   */
  async sendSOSNotify(elderlyId: string) {
    const elderly = await this.prisma.elderly.findUnique({
      where: { id: elderlyId },
      include: { user: true },
    });

    if (!elderly) return;

    console.log(`[紧急通知] 老人 ${elderly.name} 发起紧急求助！`);

    // TODO: 发送紧急通知给子女
    // 1. 订阅消息
    // 2. 短信
    // 3. 电话（如有紧急联系服务）
  }

  // ============ 系统消息 ============

  /**
   * 创建系统消息
   */
  async createSystemMessage(params: {
    userId: string;
    userType: string;
    title: string;
    content: string;
    type?: string;
    relatedId?: string;
  }) {
    // TODO: 保存到消息表
    console.log('[系统消息]', params);
    return { success: true };
  }

  /**
   * 获取消息列表
   */
  async getMessages(userId: string, userType: string, page = 1, pageSize = 20) {
    // TODO: 从消息表查询
    return {
      success: true,
      data: {
        list: [
          {
            id: '1',
            title: '订单已支付',
            content: '您的订单 202601200001 已支付成功',
            type: 'order',
            isRead: false,
            createdAt: new Date(),
          },
          {
            id: '2',
            title: '天使已接单',
            content: '天使 李天使 已接受您的订单',
            type: 'order',
            isRead: true,
            createdAt: new Date(Date.now() - 3600000),
          },
        ],
        total: 2,
        page,
        pageSize,
      },
    };
  }

  /**
   * 标记消息已读
   */
  async markAsRead(messageId: string, userId: string) {
    // TODO: 更新消息状态
    return { success: true };
  }

  /**
   * 获取未读消息数
   */
  async getUnreadCount(userId: string, userType: string) {
    // TODO: 查询未读消息数
    return {
      success: true,
      data: { count: 2 },
    };
  }

  // ============ 订单消息 (简易 IM) ============

  /**
   * 发送订单消息
   */
  async sendOrderMessage(params: {
    orderId: string;
    senderId: string;
    senderType: string;
    content: string;
    messageType?: 'text' | 'image';
  }) {
    const { orderId, senderId, senderType, content, messageType = 'text' } = params;

    // TODO: 保存消息到数据库
    const message = {
      id: `msg_${Date.now()}`,
      orderId,
      senderId,
      senderType,
      content,
      messageType,
      createdAt: new Date(),
    };

    console.log('[订单消息]', message);

    // TODO: 推送给接收方（WebSocket 或订阅消息）

    return {
      success: true,
      data: message,
    };
  }

  /**
   * 获取订单消息列表
   */
  async getOrderMessages(orderId: string, userId: string, lastId?: string) {
    // TODO: 验证用户权限并查询消息
    return {
      success: true,
      data: [
        {
          id: 'msg_1',
          senderId: 'user_1',
          senderType: 'child',
          senderName: '张先生',
          content: '请帮忙买点水果',
          messageType: 'text',
          createdAt: new Date(Date.now() - 7200000),
        },
        {
          id: 'msg_2',
          senderId: 'angel_1',
          senderType: 'angel',
          senderName: '李天使',
          content: '好的，有什么偏好吗？',
          messageType: 'text',
          createdAt: new Date(Date.now() - 3600000),
        },
      ],
    };
  }

  // ============ 私有方法 ============

  /**
   * 获取微信 access_token
   */
  private async getAccessToken(): Promise<string> {
    // TODO: 实现 access_token 获取和缓存
    // 1. 先从缓存获取
    // 2. 如果过期，调用微信 API 获取新的
    // 3. 缓存新的 token

    const appId = this.configService.wechatAppId;
    const appSecret = this.configService.wechatAppSecret;

    try {
      const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`;
      const response = await fetch(url);
      const result = await response.json();
      return result.access_token || '';
    } catch (error) {
      console.error('获取 access_token 失败:', error);
      return '';
    }
  }
}

