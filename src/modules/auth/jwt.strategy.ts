import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '../../config/config.service';
import { JwtPayload, UserType } from './dto/auth.dto';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.jwtSecret,
    });
  }

  /**
   * 验证 JWT Payload，返回用户信息
   */
  async validate(payload: JwtPayload) {
    const { sub, userType } = payload;

    let user: any;

    switch (userType) {
      case UserType.CHILD:
        user = await this.prisma.user.findUnique({ where: { id: sub } });
        break;
      case UserType.ANGEL:
        user = await this.prisma.angel.findUnique({ where: { id: sub } });
        break;
      case UserType.ELDERLY:
        user = await this.prisma.elderly.findUnique({ where: { id: sub } });
        break;
    }

    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }

    return {
      id: user.id,
      phone: user.phone,
      name: user.name,
      userType,
    };
  }
}
