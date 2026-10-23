import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    // Liveness only: no database or simulator exists on Day 1.
    return { status: 'ok', service: 'warehouse-twin-api', devices: 'simulated' };
  }
}
