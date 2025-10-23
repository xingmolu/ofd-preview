import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createWriteStream, existsSync, mkdirSync, statSync, createReadStream } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

export interface ResolvedFile {
  type: 'path';
  absolutePath: string;
}

@Injectable()
export class FileService {
  private readonly root: string;
  private readonly uploadDir: string;
  private readonly maxSizeBytes: number;

  constructor() {
    // Default root: '/data' as absolute to match acceptance example
    this.root = process.env.OFD_ROOT || '/data';
    this.maxSizeBytes = parseInt(process.env.MAX_OFD_SIZE || `${100 * 1024 * 1024}`); // 100 MiB
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }
    this.uploadDir = path.join(this.root, 'uploads');
    if (!existsSync(this.uploadDir)) {
      mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  getRootDir() {
    return this.root;
  }

  resolve(fileParam: string): ResolvedFile {
    if (!fileParam) throw new BadRequestException('file parameter is required');

    if (fileParam.startsWith('id:')) {
      const id = fileParam.substring(3);
      const filePath = path.join(this.uploadDir, id);
      return this.ensureInsideRoot(filePath);
    }

    let candidate = fileParam;
    if (path.isAbsolute(candidate)) {
      // Allow absolute path only if inside root
      candidate = path.normalize(candidate);
      if (!candidate.startsWith(path.normalize(this.root + path.sep))) {
        throw new ForbiddenException('Absolute paths not allowed unless within OFD_ROOT');
      }
    } else {
      candidate = path.join(this.root, candidate);
    }
    return this.ensureInsideRoot(candidate);
  }

  ensureInsideRoot(p: string): ResolvedFile {
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
    return { type: 'path', absolutePath: normalized };
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

  createReadStream(fileParam: string) {
    const res = this.resolve(fileParam);
    return createReadStream(res.absolutePath);
  }
}
