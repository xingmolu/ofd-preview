import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

jest.setTimeout(30000);

describe('OFD API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.OFD_ROOT = '/data';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/ofd/metadata returns metadata', async () => {
    const res = await request(app.getHttpServer()).get('/api/ofd/metadata').query({ file: '/data/sample.ofd' }).expect(200);
    expect(res.body.pages).toBeGreaterThanOrEqual(1);
    expect(res.body.textExtractable).toBe(true);
    expect(res.body.capabilities).toBeDefined();
    expect(res.body.capabilities.text).toBe(true);
    expect(res.body.engine).toBeDefined();
  });

  it('GET /api/ofd/page returns svg', async () => {
    const res = await request(app.getHttpServer()).get('/api/ofd/page').query({ file: '/data/sample.ofd', page: 1, format: 'svg' }).expect(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.text).toContain('<svg');
  });

  it('GET /api/ofd/page returns png', async () => {
    const res = await request(app.getHttpServer()).get('/api/ofd/page').query({ file: '/data/sample.ofd', page: 1, format: 'png' }).expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('GET /api/ofd/metadata with non-existing file returns 404', async () => {
    await request(app.getHttpServer()).get('/api/ofd/metadata').query({ file: '/data/not-exist.ofd' }).expect(404);
  });
});
