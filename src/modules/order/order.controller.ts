import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { OrderService } from './order.service';
import {
  CreateOrderDto,
  QueryOrderDto,
  NearbyOrdersDto,
  CancelOrderDto,
  RateOrderDto,
  CompleteServiceDto,
} from './dto/order.dto';

@ApiTags('订单')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('orders')
export class OrderController {
  constructor(private orderService: OrderService) {}

  @Post()
  @ApiOperation({ summary: '创建订单' })
  @ApiResponse({ status: 201, description: '创建成功' })
  async create(@Request() req, @Body() dto: CreateOrderDto) {
    return this.orderService.create(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: '获取订单列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async list(@Request() req, @Query() query: QueryOrderDto) {
    return this.orderService.list(req.user.id, req.user.userType, query);
  }

  @Get('nearby')
  @ApiOperation({ summary: '获取附近订单（天使端）' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getNearbyOrders(@Request() req, @Query() query: NearbyOrdersDto) {
    return this.orderService.getNearbyOrders(req.user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取订单详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getDetail(@Request() req, @Param('id') id: string) {
    return this.orderService.getDetail(id, req.user.id, req.user.userType);
  }

  @Post(':id/accept')
  @ApiOperation({ summary: '天使接单' })
  @ApiResponse({ status: 200, description: '接单成功' })
  async accept(@Request() req, @Param('id') id: string) {
    return this.orderService.accept(id, req.user.id);
  }

  @Post(':id/depart')
  @ApiOperation({ summary: '天使出发' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async depart(@Request() req, @Param('id') id: string) {
    return this.orderService.startDepart(id, req.user.id);
  }

  @Post(':id/arrive')
  @ApiOperation({ summary: '天使到达' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async arrive(@Request() req, @Param('id') id: string) {
    return this.orderService.arrive(id, req.user.id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: '开始服务' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async start(@Request() req, @Param('id') id: string) {
    return this.orderService.startService(id, req.user.id);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: '完成服务（天使端）' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async complete(@Request() req, @Param('id') id: string, @Body() dto: CompleteServiceDto) {
    return this.orderService.completeService(id, req.user.id, dto);
  }

  @Post(':id/confirm')
  @ApiOperation({ summary: '确认完成（子女端）' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async confirm(@Request() req, @Param('id') id: string) {
    return this.orderService.confirmComplete(id, req.user.id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '取消订单' })
  @ApiResponse({ status: 200, description: '取消成功' })
  async cancel(@Request() req, @Param('id') id: string, @Body() dto: CancelOrderDto) {
    return this.orderService.cancel(id, req.user.id, dto);
  }

  @Post(':id/rate')
  @ApiOperation({ summary: '评价订单' })
  @ApiResponse({ status: 200, description: '评价成功' })
  async rate(@Request() req, @Param('id') id: string, @Body() dto: RateOrderDto) {
    return this.orderService.rate(id, req.user.id, dto);
  }
}
