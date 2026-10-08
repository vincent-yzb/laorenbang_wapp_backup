import { IsString, Length, MaxLength, Matches, ValidateIf } from 'class-validator';

export class UpdateProfileDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(1, 80)
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  avatar?: string;
}

export class VerifyIdentityDto {
  @IsString()
  @Length(1, 80)
  name: string;

  @IsString()
  @Matches(/^\d{17}[\dXx]$/)
  idCard: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  idCardFront?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  idCardBack?: string;
}
