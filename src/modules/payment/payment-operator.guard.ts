import { CanActivate, ExecutionContext, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

/** Separate operational credential; a customer or angel JWT never authorizes money-out approval. */
@Injectable()
export class PaymentOperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.PAYMENT_OPERATOR_TOKEN;
    if (!expected || expected.length < 32) throw new ServiceUnavailableException('资金审核入口尚未配置');
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!supplied || supplied.length > 512 || !timingSafeEqual(hash(supplied), hash(expected))) throw new ForbiddenException('无权审核资金操作');
    const identity = request.headers?.['x-payment-operator'];
    if (typeof identity !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(identity)) throw new ForbiddenException('请提供审核人员标识');
    request.paymentOperator = identity;
    return true;
  }
}
