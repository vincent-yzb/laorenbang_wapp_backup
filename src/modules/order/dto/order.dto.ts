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
} from 'class-validator';

/**
 * 订单状态枚举
 */
export enum OrderStatus {
  PENDING = 'PENDING',           // 待支付
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
  address: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsNotEmpty({ message: '服务时间不能为空' })
  @IsDateString()
  serviceTime: string;

  @IsOptional()
  @IsString()
  remark?: string;

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
  page?: number = 1;

  @IsOptional()
  pageSize?: number = 10;
}

/**
 * 天使附近订单查询 DTO
 */
export class NearbyOrdersDto {
  @IsNotEmpty()
  @IsNumber()
  lat: number;

  @IsNotEmpty()
  @IsNumber()
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
  comment?: string;
}

/**
 * 完成服务 DTO
 */
export class CompleteServiceDto {
  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
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

