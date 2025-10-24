import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { FileService } from './file.service';
import { OfdParser, ParsedDoc, OfdMetadata, PageTextItem, OfdDocumentCapabilities } from './parser';
import { readFileSync } from 'fs';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SVGtoPDF = require('svg-to-pdfkit');
import { LRUCache } from 'lru-cache';

interface CacheEntryDoc { doc: ParsedDoc; buf: Buffer; key: string; mtimeMs: number; }
interface CacheEntryPage { svg: string; text: PageTextItem[]; docMtimeMs: number; }
interface DocumentInfo { meta: OfdMetadata; capabilities: OfdDocumentCapabilities; engine: string; }

@Injectable()
export class OfdService {
  private readonly parser: OfdParser;
  private docCache = new LRUCache<string, CacheEntryDoc>({ max: 64, ttl: 10 * 60 * 1000 });
  private pageCache = new LRUCache<string, CacheEntryPage>({ max: 256, ttl: 10 * 60 * 1000 });

  constructor(private readonly files: FileService) {
    const disableOfdrw = this.parseBoolean(process.env.OFDRW_DISABLE);
    const timeoutEnv = process.env.OFDRW_TIMEOUT;
    const parsedTimeout = timeoutEnv ? parseInt(timeoutEnv, 10) : undefined;
    const timeout = parsedTimeout !== undefined && !Number.isNaN(parsedTimeout) ? parsedTimeout : undefined;
    this.parser = new OfdParser({
      disableOfdrw,
      ofdrwCliPath: process.env.OFDRW_CLI || process.env.OFDRW_CLI_PATH,
      strategyTimeoutMs: timeout,
    });
  }

  private async loadDoc(fileParam: string): Promise<CacheEntryDoc> {
    const resolved = await this.files.resolve(fileParam);
    const key = resolved.absolutePath;
    const mtimeMs = resolved.mtimeMs;

    const existing = this.docCache.get(key);
    if (existing && existing.mtimeMs === mtimeMs) {
      return existing;
    }

    const buf = readFileSync(key);
    const parsed = await this.withTimeout(this.parser.parse(buf), 15000);
    const entry: CacheEntryDoc = { doc: parsed, buf, key, mtimeMs };
    this.docCache.set(key, entry);
    return entry;
  }

  async getDocumentInfo(fileParam: string): Promise<DocumentInfo> {
    const { doc } = await this.loadDoc(fileParam);
    return { meta: doc.meta, capabilities: doc.capabilities, engine: doc.engine };
  }

  async getMetadata(fileParam: string): Promise<OfdMetadata> {
    const { doc } = await this.loadDoc(fileParam);
    return doc.meta;
  }

  async getCapabilities(fileParam: string): Promise<OfdDocumentCapabilities> {
    const { doc } = await this.loadDoc(fileParam);
    return doc.capabilities;
  }

  async getPage(fileParam: string, page: number, format: 'svg' | 'png' | 'pdf', scale = 1) {
    const { doc, buf, key, mtimeMs } = await this.loadDoc(fileParam);
    if (page < 1 || page > doc.meta.pages) throw new Error('Invalid page index');

    const cacheKey = `${key}#${page}`;
    let pageEntry = this.pageCache.get(cacheKey);
    if (!pageEntry || pageEntry.docMtimeMs !== mtimeMs) {
      const rendered = await this.withTimeout(this.parser.renderPage(buf, doc, page - 1), 20000);
      pageEntry = { svg: rendered.svg, text: rendered.text ?? [], docMtimeMs: mtimeMs };
      this.pageCache.set(cacheKey, pageEntry);
    }

    if (format === 'svg') {
      return { contentType: 'image/svg+xml', body: Buffer.from(pageEntry.svg, 'utf-8') };
    }

    if (format === 'png') {
      const svgBuffer = Buffer.from(pageEntry.svg, 'utf-8');
      const density = Math.max(96, Math.floor(96 * (scale && scale > 0 ? scale : 1)));
      const baseImage = sharp(svgBuffer, { density });
      const metadata = await baseImage.metadata();
      let pipeline = baseImage;
      if (scale && scale > 0 && scale !== 1 && metadata.width) {
        const targetWidth = Math.max(1, Math.floor(metadata.width * scale));
        pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: false });
      }
      const bufPng = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      return { contentType: 'image/png', body: bufPng };
    }

    if (format === 'pdf') {
      const docPdf = new PDFDocument({ size: [this.mmToPt(doc.meta.widthMM), this.mmToPt(doc.meta.heightMM)] });
      const chunks: Buffer[] = [];
      const result = new Promise<Buffer>((resolve, reject) => {
        docPdf.on('data', (c: Buffer) => chunks.push(c));
        docPdf.on('end', () => resolve(Buffer.concat(chunks)));
        docPdf.on('error', reject);
      });
      SVGtoPDF(docPdf, pageEntry.svg, 0, 0, { assumePt: false, preserveAspectRatio: 'xMinYMin meet' });
      docPdf.end();
      const pdfBuf = await result;
      return { contentType: 'application/pdf', body: pdfBuf };
    }

    throw new InternalServerErrorException('Unsupported format');
  }

  async getText(fileParam: string, page: number) {
    const { doc, buf, key, mtimeMs } = await this.loadDoc(fileParam);
    if (page < 1 || page > doc.meta.pages) throw new Error('Invalid page index');
    const cacheKey = `${key}#${page}`;
    let pageEntry = this.pageCache.get(cacheKey);
    if (!pageEntry || pageEntry.docMtimeMs !== mtimeMs) {
      const rendered = await this.withTimeout(this.parser.renderPage(buf, doc, page - 1), 20000);
      pageEntry = { svg: rendered.svg, text: rendered.text ?? [], docMtimeMs: mtimeMs };
      this.pageCache.set(cacheKey, pageEntry);
    }
    return { items: pageEntry.text };
  }

  private parseBoolean(value?: string) {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  }

  private mmToPt(mm: number) {
    return (mm / 25.4) * 72.0;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
    });
    return Promise.race([p.finally(() => {
      if (timer) clearTimeout(timer);
    }), t]);
  }
}
