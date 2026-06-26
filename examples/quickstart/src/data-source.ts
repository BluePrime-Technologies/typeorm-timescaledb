import 'reflect-metadata';
import { DataSource } from 'typeorm-timescaledb';
import { Reading } from './entities/Reading.js';

const port = Number(process.env.POSTGRES_PORT ?? '5432');

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port,
  username: process.env.POSTGRES_USER ?? 'timescale',
  password: process.env.POSTGRES_PASSWORD ?? 'timescale',
  database: process.env.POSTGRES_DB ?? 'quickstart',
  entities: [Reading],
  migrations: ['src/migrations/*.{ts,js}'],
  synchronize: false,
  logging: false,
});
