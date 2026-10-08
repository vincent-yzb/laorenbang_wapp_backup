import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityService } from './identity.service';
import { UserTypeGuard } from './user-type.guard';
import { JwtStrategy } from './jwt.strategy';
import { ConfigService } from '../../config/config.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => ({
        secret: configService.jwtSecret,
        signOptions: { expiresIn: configService.jwtExpiresIn },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, IdentityService, JwtStrategy, UserTypeGuard],
  exports: [AuthService, IdentityService, JwtModule, UserTypeGuard],
})
export class AuthModule {}
