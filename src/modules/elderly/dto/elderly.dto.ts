import { IsString, IsMobilePhone, IsNumber, Min, Max, Length, MaxLength, ValidateIf } from 'class-validator';

class ElderlyDetailsDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2048)
  avatar?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  healthNote?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  angelNote?: string;
}

export class CreateElderlyDto extends ElderlyDetailsDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsString()
  @Length(1, 80)
  name: string;

  @IsMobilePhone('zh-CN')
  phone: string;

  @IsString()
  @Length(1, 40)
  relation: string;

  @IsString()
  @Length(1, 500)
  address: string;
}

export class UpdateElderlyDto extends ElderlyDetailsDto {
  // Omitted coordinates preserve the stored location; explicit null clears it.
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number | null;

  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(1, 80)
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsMobilePhone('zh-CN')
  phone?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(1, 40)
  relation?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(1, 500)
  address?: string;
}
