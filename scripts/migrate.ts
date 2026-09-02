import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, DATABASE_PATH } from '@/lib/db';

migrate(db, { migrationsFolder: './drizzle/migrations' });
console.log(`migrations applied → ${DATABASE_PATH}`);
