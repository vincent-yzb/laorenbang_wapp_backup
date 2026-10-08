import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { map } from 'rxjs/operators';

/** JSON represents all 64-bit cent amounts as decimal strings without precision loss. */
export function serializeMoney(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(serializeMoney);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeMoney(item)]));
}
@Injectable()
export class MoneySerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) { return next.handle().pipe(map(serializeMoney)); }
}
