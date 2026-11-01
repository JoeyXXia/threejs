import { BadRequestException } from '@nestjs/common';

export function objectInput(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new BadRequestException('Unknown field');
  return input;
}

export function textInput(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new BadRequestException('Invalid text');
  }
  return value.trim();
}

export function uuidInput(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException('Invalid ID');
  }
  return value;
}
