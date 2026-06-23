import 'reflect-metadata';
import { DataSource } from 'typeorm-timescaledb';

const port = Number(process.env.POSTGRES_PORT ?? '5432');

export const LocalTimescaleDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port,
  username: process.env.POSTGRES_USER ?? 'timescale',
  password: process.env.POSTGRES_PASSWORD ?? 'timescale',
  database: process.env.POSTGRES_DB ?? 'typeorm_timescaledb_local',
  entities: ['src/entities/*.{ts,js}'],
  migrations: ['src/migrations/*.{ts,js}'],
  synchronize: false,
  logging: false,
});
