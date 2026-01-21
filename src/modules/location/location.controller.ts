import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { LocationService } from './location.service';

@ApiTags('位置服务')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('location')
export class LocationController {
  constructor(private locationService: LocationService) {}

  @Post('report')
  @ApiOperation({ summary: '上报位置（天使端）' })
  @ApiResponse({ status: 200, description: '上报成功' })
  async reportLocation(
    @Request() req,
    @Body() body: { lat: number; lng: number },
  ) {
    return this.locationService.reportLocation(req.user.id, body.lat, body.lng);
  }

  @Get('angel/:orderId')
  @ApiOperation({ summary: '获取天使实时位置' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getAngelLocation(@Request() req, @Param('orderId') orderId: string) {
    return this.locationService.getAngelLocation(orderId, req.user.id);
  }

  @Get('track/:orderId')
  @ApiOperation({ summary: '获取服务轨迹' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getTrack(@Request() req, @Param('orderId') orderId: string) {
    return this.locationService.getTrack(orderId, req.user.id);
  }

  @Get('reverse-geocode')
  @ApiOperation({ summary: '逆地理编码（经纬度转地址）' })
  @ApiResponse({ status: 200, description: '解析成功' })
  async reverseGeocode(
    @Query('lat') lat: number,
    @Query('lng') lng: number,
  ) {
    return this.locationService.reverseGeocode(+lat, +lng);
  }

  @Get('geocode')
  @ApiOperation({ summary: '地理编码（地址转经纬度）' })
  @ApiResponse({ status: 200, description: '解析成功' })
  async geocode(
    @Query('address') address: string,
    @Query('city') city?: string,
  ) {
    return this.locationService.geocode(address, city);
  }

  @Get('distance')
  @ApiOperation({ summary: '计算两点距离' })
  @ApiResponse({ status: 200, description: '计算成功' })
  async calculateDistance(
    @Query('fromLat') fromLat: number,
    @Query('fromLng') fromLng: number,
    @Query('toLat') toLat: number,
    @Query('toLng') toLng: number,
  ) {
    return this.locationService.calculateDistanceAPI({
      fromLat: +fromLat,
      fromLng: +fromLng,
      toLat: +toLat,
      toLng: +toLng,
    });
  }
}

