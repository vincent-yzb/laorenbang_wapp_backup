import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserType } from './dto/auth.dto';

export const RequireUserType = (type: UserType) => SetMetadata('identity:userType', type);

@Injectable()
export class UserTypeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserType>('identity:userType', [context.getHandler(), context.getClass()]);
    if (required && context.switchToHttp().getRequest().user?.userType !== required) {
      throw new ForbiddenException('当前账号类型无权执行此操作');
    }
    return true;
  }
}
