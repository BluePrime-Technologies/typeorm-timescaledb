import { createTimescale } from 'typeorm-timescaledb';
import { AppDataSource } from './data-source.js';
import { Reading } from './entities/Reading.js';

await AppDataSource.initialize();

const ts = createTimescale(AppDataSource);
await ts.assertSchema();

const readings = ts.getRepository(Reading);

await readings.insert({
  time: new Date(),
  sensorId: 'sensor-1',
  value: 42.5,
});

const latest = await readings.find({
  order: { time: 'DESC' },
  take: 1,
});

console.log(latest);

await AppDataSource.destroy();
