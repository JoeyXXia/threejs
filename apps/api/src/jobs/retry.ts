import { PrismaClient } from '@warehouse-twin/database';
import { retryDispatchReport } from './dispatch-report';

async function main() {
  const [id, generation, ...rest] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !id || !generation || !/^\d{1,10}$/.test(generation) || rest.length) {
    throw new Error('Expected DATABASE_URL, intent UUID and expected failed generation');
  }
  const db = new PrismaClient();
  try {
    if (!(await retryDispatchReport(db, id, Number(generation)))) {
      console.error('No matching incomplete failed generation; nothing changed');
      process.exitCode = 2;
    } else console.log('New generation scheduled in PostgreSQL');
  } finally { await db.$disconnect(); }
}

main().catch(() => { console.error('Retry rejected; check explicit database configuration, intent UUID and expected generation'); process.exitCode = 1; });
