import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('services')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('types')
  async list() {
    const data = await this.prisma.serviceType.findMany({
      where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return { success: true, data };
  }

  @Get('types/:id')
  async detail(@Param('id') id: string) {
    const data = await this.prisma.serviceType.findFirst({ where: { id, isActive: true } });
    if (!data) throw new NotFoundException('服务类型不存在或已停用');
    return { success: true, data };
  }
}
