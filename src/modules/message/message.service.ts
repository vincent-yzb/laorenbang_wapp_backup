import { Injectable, ServiceUnavailableException } from '@nestjs/common';

/** Messaging is unavailable until persistence and delivery are implemented. */
@Injectable()
export class MessageService {
  private unavailable(): never {
    throw new ServiceUnavailableException('消息通知尚未开通，请通过电话联系服务相关人员');
  }

  async sendSubscribeMessage(_params: {
    touser: string;
    templateId: string;
    page?: string;
    data: Record<string, { value: string }>;
  }): Promise<never> {
    return this.unavailable();
  }

  async sendOrderStatusNotify(_orderId: string, _status: string): Promise<never> {
    return this.unavailable();
  }

  async sendSOSNotify(_elderlyId: string): Promise<never> {
    throw new ServiceUnavailableException('线上求助通知尚未开通，请立即联系家人或拨打紧急电话');
  }

  async createSystemMessage(_params: {
    userId: string;
    userType: string;
    title: string;
    content: string;
    type?: string;
    relatedId?: string;
  }): Promise<never> {
    return this.unavailable();
  }

  async getMessages(_userId: string, _userType: string, _page = 1, _pageSize = 20): Promise<never> {
    return this.unavailable();
  }

  async markAsRead(_messageId: string, _userId: string): Promise<never> {
    return this.unavailable();
  }

  async getUnreadCount(_userId: string, _userType: string): Promise<never> {
    return this.unavailable();
  }

  async sendOrderMessage(_params: {
    orderId: string;
    senderId: string;
    senderType: string;
    content: string;
    messageType?: 'text' | 'image';
  }): Promise<never> {
    return this.unavailable();
  }

  async getOrderMessages(_orderId: string, _userId: string, _lastId?: string): Promise<never> {
    return this.unavailable();
  }
}
