import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream as fsCreateReadStream } from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { randomBytes, createHash } from 'crypto';

const REMOTE_CACHE_TTL_DEFAULT = 5 * 60 * 1000; // 5 minutes
const REMOTE_FETCH_TIMEOUT_DEFAULT = 20 * 1000; // 20 seconds

export interface ResolvedFile {
  type: 'path';
  absolutePath: string;
  source: 'local' | 'upload' | 'remote';
  mtimeMs: number;
  original?: string;
}

@Injectable()
export class FileService {
  private readonly root: string;
  private readonly uploadDir: string;
  private readonly remoteCacheDir: string;
  private readonly maxSizeBytes: number;
  private readonly remoteCacheTtlMs: number;
  private readonly remoteFetchTimeoutMs: number;
  private readonly remoteDownloads = new Map<string, Promise<void>>();

  constructor() {
    this.root = process.env.OFD_ROOT || '/data';
    this.maxSizeBytes = parseInt(process.env.MAX_OFD_SIZE || `${100 * 1024 * 1024}`, 10); // 100 MiB
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }

    this.uploadDir = path.join(this.root, 'uploads');
    if (!existsSync(this.uploadDir)) {
      mkdirSync(this.uploadDir, { recursive: true });
    }

    this.remoteCacheDir = path.join(this.root, 'remote-cache');
    if (!existsSync(this.remoteCacheDir)) {
      mkdirSync(this.remoteCacheDir, { recursive: true });
    }

    const remoteTtlEnv = process.env.OFD_REMOTE_CACHE_TTL;
    const parsedTtl = remoteTtlEnv ? parseInt(remoteTtlEnv, 10) : REMOTE_CACHE_TTL_DEFAULT;
    this.remoteCacheTtlMs = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : REMOTE_CACHE_TTL_DEFAULT;

    const remoteTimeoutEnv = process.env.OFD_REMOTE_TIMEOUT;
    const parsedTimeout = remoteTimeoutEnv ? parseInt(remoteTimeoutEnv, 10) : REMOTE_FETCH_TIMEOUT_DEFAULT;
    this.remoteFetchTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : REMOTE_FETCH_TIMEOUT_DEFAULT;
  }

  getRootDir() {
    return this.root;
  }

  async resolve(fileParam: string): Promise<ResolvedFile> {
    if (!fileParam) throw new BadRequestException('file parameter is required');

    if (this.isRemoteUrl(fileParam)) {
      const absolutePath = await this.fetchRemote(fileParam);
      return this.ensureInsideRoot(absolutePath, 'remote', fileParam);
    }

    if (fileParam.startsWith('id:')) {
      const id = fileParam.substring(3);
      const filePath = path.join(this.uploadDir, id);
      return this.ensureInsideRoot(filePath, 'upload', fileParam);
    }

    let candidate = fileParam;
    if (path.isAbsolute(candidate)) {
      candidate = path.normalize(candidate);
      if (!candidate.startsWith(path.normalize(this.root + path.sep))) {
        throw new ForbiddenException('Absolute paths not allowed unless within OFD_ROOT');
      }
    } else {
      candidate = path.join(this.root, candidate);
    }

    return this.ensureInsideRoot(candidate, 'local', fileParam);
  }

  private ensureInsideRoot(p: string, source: ResolvedFile['source'], original?: string): ResolvedFile {
    const normalized = path.normalize(p);
    if (!normalized.startsWith(path.normalize(this.root + path.sep))) {
      throw new ForbiddenException('Path traversal outside OFD_ROOT is forbidden');
    }
    if (!existsSync(normalized)) {
      throw new NotFoundException('File not found');
    }
    const st = statSync(normalized);
    if (!st.isFile()) throw new NotFoundException('Not a file');
    if (st.size > this.maxSizeBytes) throw new BadRequestException('File too large');
    return { type: 'path', absolutePath: normalized, source, mtimeMs: st.mtimeMs, original };
  }

  async saveUpload(buffer: Buffer, originalname?: string): Promise<string> {
    const ext = path.extname(originalname || '') || '.ofd';
    const id = `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
    const abs = path.join(this.uploadDir, id);
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(abs);
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      ws.end(buffer);
    });
    return id;
  }

  async createReadStream(fileParam: string) {
    const res = await this.resolve(fileParam);
    return fsCreateReadStream(res.absolutePath);
  }

  private isRemoteUrl(value: string) {
    return /^https?:\/\//i.test(value);
  }

  private async fetchRemote(url: string): Promise<string> {
    let remoteUrl: URL;
    try {
      remoteUrl = new URL(url);
    } catch (err) {
      throw new BadRequestException('Invalid remote OFD URL');
    }

    if (remoteUrl.protocol !== 'http:' && remoteUrl.protocol !== 'https:') {
      throw new BadRequestException('Only HTTP(S) URLs are supported for remote OFD files');
    }

    const hash = createHash('sha1').update(url).digest('hex');
    const extCandidate = path.extname(remoteUrl.pathname).toLowerCase();
    const ext = extCandidate && extCandidate.length <= 16 && /^[.\w-]+$/.test(extCandidate) ? extCandidate : '.ofd';
    const dest = path.join(this.remoteCacheDir, `${hash}${ext}`);
    const now = Date.now();

    if (existsSync(dest)) {
      const st = statSync(dest);
      if (st.size > 0 && now - st.mtimeMs <= this.remoteCacheTtlMs) {
        return dest;
      }
    }

    const inFlight = this.remoteDownloads.get(dest);
    if (inFlight) {
      await inFlight;
      return dest;
    }

    const downloadPromise = this.downloadRemote(url, dest);
    this.remoteDownloads.set(dest, downloadPromise);
    try {
      await downloadPromise;
    } finally {
      this.remoteDownloads.delete(dest);
    }
    return dest;
  }

  private async downloadRemote(url: string, dest: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.remoteFetchTimeoutMs);
    const tempPath = `${dest}.${Date.now()}.tmp`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'application/ofd,application/octet-stream,*/*',
        },
      });

      if (!res.ok) {
        throw new BadRequestException(`Remote server responded with ${res.status} ${res.statusText}`);
      }

      const lengthHeader = res.headers.get('content-length');
      if (lengthHeader) {
        const length = parseInt(lengthHeader, 10);
        if (Number.isFinite(length) && length > this.maxSizeBytes) {
          throw new BadRequestException('Remote OFD exceeds maximum allowed size');
        }
      }

      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      if (buf.length === 0) {
        throw new BadRequestException('Remote OFD is empty');
      }
      if (buf.length > this.maxSizeBytes) {
        throw new BadRequestException('Remote OFD exceeds maximum allowed size');
      }

      await fsp.writeFile(tempPath, buf);
      await fsp.rm(dest, { force: true }).catch(() => undefined);
      await fsp.rename(tempPath, dest);
    } catch (error: unknown) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof BadRequestException) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BadRequestException('Fetching remote OFD timed out');
      }
      throw new BadRequestException(`Failed to fetch remote OFD: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
