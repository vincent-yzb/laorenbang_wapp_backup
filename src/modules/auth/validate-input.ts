import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/** Validate again at the service boundary, including callers outside HTTP. */
export function validateInput<T extends object>(type: new () => T, input: unknown): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('请求参数无效');
  }
  const dto = plainToInstance(type, input);
  if (validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  }).length) {
    throw new BadRequestException('请求参数无效或包含不允许修改的字段');
  }
  return dto;
}
