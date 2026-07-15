import { AppDataSource } from './data-source.js';

await AppDataSource.initialize();
await AppDataSource.synchronize();
await AppDataSource.destroy();

console.log('Base TypeORM table created.');
