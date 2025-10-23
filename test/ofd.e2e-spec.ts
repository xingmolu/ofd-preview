import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import path from 'path';
import { AppModule } from '../src/app.module';

jest.setTimeout(30000);

describe('OFD API (e2e)', () => {
  let app: INestApplication;
  let remoteServer: Server | undefined;
  let remoteUrl: string | undefined;

  beforeAll(async () => {
    process.env.OFD_ROOT = '/data';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const samplePath = path.join(process.env.OFD_ROOT || '/data', 'sample.ofd');
    const sampleBuf = readFileSync(samplePath);

    remoteServer = createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/ofd',
        'Content-Length': sampleBuf.length,
      });
      res.end(sampleBuf);
    });

    await new Promise<void>((resolve) => remoteServer!.listen(0, '127.0.0.1', resolve));
    const address = remoteServer.address() as AddressInfo | string | null;
    if (address && typeof address === 'object') {
      remoteUrl = `http://127.0.0.1:${address.port}/sample.ofd`;
    } else {
      throw new Error('Failed to start remote OFD server');
    }
  });

  afterAll(async () => {
    await app.close();
    if (remoteServer) {
      await new Promise<void>((resolve) => remoteServer!.close(() => resolve()));
    }
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

  it('supports remote OFD URLs', async () => {
    expect(remoteUrl).toBeDefined();
    const meta = await request(app.getHttpServer()).get('/api/ofd/metadata').query({ file: remoteUrl }).expect(200);
    expect(meta.body.pages).toBeGreaterThanOrEqual(1);

    const page = await request(app.getHttpServer()).get('/api/ofd/page').query({ file: remoteUrl, page: 1, format: 'svg' }).expect(200);
    expect(page.headers['content-type']).toContain('image/svg+xml');
    expect(page.text).toContain('<svg');
  });
});
