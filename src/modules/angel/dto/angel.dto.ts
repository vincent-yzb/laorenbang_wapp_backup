import { IsBoolean, IsMobilePhone, IsString, MaxLength, ValidateIf } from 'class-validator';
import { VerifyIdentityDto } from '../../user/dto/user.dto';

export class ApplyAngelDto extends VerifyIdentityDto {
  @IsMobilePhone('zh-CN')
  phone: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  avatar?: string;
}

export class ToggleOnlineDto {
  @IsBoolean()
  isOnline: boolean;
}
