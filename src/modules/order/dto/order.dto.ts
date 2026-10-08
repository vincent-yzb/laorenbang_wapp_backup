import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsEnum,
  IsDateString,
  Min,
  Max,
  IsBoolean,
  IsInt,
  IsArray,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 订单状态枚举
 */
export enum OrderStatus {
  PENDING = 'PENDING',           // 待接单，服务后付款
  PAID = 'PAID',                 // 已支付，待接单
  ACCEPTED = 'ACCEPTED',         // 已接单
  ON_WAY = 'ON_WAY',             // 天使出发中
  ARRIVED = 'ARRIVED',           // 天使已到达
  IN_PROGRESS = 'IN_PROGRESS',   // 服务中
  PENDING_CONFIRM = 'PENDING_CONFIRM', // 待确认（天使已完成，等子女确认）
  COMPLETED = 'COMPLETED',       // 已完成
  CANCELLED = 'CANCELLED',       // 已取消
  REFUNDED = 'REFUNDED',         // 已退款
}

/**
 * 创建订单 DTO
 */
export class CreateOrderDto {
  @IsNotEmpty({ message: '服务类型不能为空' })
  @IsString()
  serviceTypeId: string;

  @IsNotEmpty({ message: '老人信息不能为空' })
  @IsString()
  elderlyId: string;

  @IsNotEmpty({ message: '服务地址不能为空' })
  @IsString()
  @MaxLength(500)
  address: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsNotEmpty({ message: '服务时间不能为空' })
  @IsDateString()
  serviceTime: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1000000)
  price?: number; // 仅定制服务允许用户报价，普通服务以数据库价格为准

  @IsOptional()
  @IsBoolean()
  isAsap?: boolean; // 是否尽快上门
}

/**
 * 订单列表查询 DTO
 */
export class QueryOrderDto {
  @IsOptional()
  @IsEnum(OrderStatus, { message: 'status 必须是有效的订单状态' })
  status?: OrderStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 10;
}

/**
 * 天使附近订单查询 DTO
 */
export class NearbyOrdersDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNotEmpty()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  radius?: number = 10; // 半径（km）
}

/**
 * 取消订单 DTO
 */
export class CancelOrderDto {
  @IsNotEmpty({ message: '取消原因不能为空' })
  @IsString()
  @MaxLength(500)
  reason: string;
}

/**
 * 订单评价 DTO
 */
export class RateOrderDto {
  @IsNotEmpty({ message: '评分不能为空' })
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/**
 * 完成服务 DTO
 */
export class CompleteServiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsString({ each: true })
  images?: string[]; // 服务照片 URLs
}

/**
 * 订单响应
 */
export interface OrderResponse {
  success: boolean;
  data?: any;
  message?: string;
}
