import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { FileService } from './file.service';
import { OfdParser, ParsedDoc, OfdMetadata } from './parser';
import { readFileSync } from 'fs';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SVGtoPDF = require('svg-to-pdfkit');
import LRU from 'lru-cache';

interface CacheEntryDoc { doc: ParsedDoc; buf: Buffer; }
interface CacheEntrySvg { svg: string; text: any; }

@Injectable()
export class OfdService {
  private parser = new OfdParser();
  private docCache = new LRU<string, CacheEntryDoc>({ max: 64, ttl: 10 * 60 * 1000 });
  private pageCache = new LRU<string, CacheEntrySvg>({ max: 256, ttl: 10 * 60 * 1000 });

  constructor(private readonly files: FileService) {}

  private async loadDoc(fileParam: string): Promise<CacheEntryDoc> {
    const resolved = this.files.resolve(fileParam);
    const key = resolved.absolutePath;
    const existing = this.docCache.get(key);
    if (existing) return existing;

    const buf = readFileSync(resolved.absolutePath);

    const parsed = await this.withTimeout(this.parser.parse(buf), 15000);
    const entry = { doc: parsed, buf };
    this.docCache.set(key, entry);
    return entry;
  }

  async getMetadata(fileParam: string): Promise<OfdMetadata> {
    const { doc } = await this.loadDoc(fileParam);
    return doc.meta;
  }

  async getPage(fileParam: string, page: number, format: 'svg'|'png'|'pdf', scale = 1) {
    const { doc, buf } = await this.loadDoc(fileParam);
    if (page < 1 || page > doc.meta.pages) throw new Error('Invalid page index');

    const cacheKey = `${this.files.resolve(fileParam).absolutePath}#${page}`;
    let svgEntry = this.pageCache.get(cacheKey);
    if (!svgEntry) {
      const { svg, text } = await this.parser.pageToSvg(buf, doc.pagePaths[page - 1], doc.meta.widthMM, doc.meta.heightMM);
      svgEntry = { svg, text };
      this.pageCache.set(cacheKey, svgEntry);
    }

    if (format === 'svg') {
      return { contentType: 'image/svg+xml', body: Buffer.from(svgEntry.svg, 'utf-8') };
    }

    if (format === 'png') {
      const svg = svgEntry.svg;
      const image = sharp(Buffer.from(svg));
      const metadata = await image.metadata();
      let width = metadata.width;
      if (width && scale && scale !== 1) width = Math.floor(width * scale);
      const bufPng = await image.png({ compressionLevel: 9 }).toBuffer();
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
      SVGtoPDF(docPdf, svgEntry.svg, 0, 0, { assumePt: false, preserveAspectRatio: 'xMinYMin meet' });
      docPdf.end();
      const pdfBuf = await result;
      return { contentType: 'application/pdf', body: pdfBuf };
    }

    throw new InternalServerErrorException('Unsupported format');
  }

  async getText(fileParam: string, page: number) {
    const { doc, buf } = await this.loadDoc(fileParam);
    if (page < 1 || page > doc.meta.pages) throw new Error('Invalid page index');
    const cacheKey = `${this.files.resolve(fileParam).absolutePath}#${page}`;
    let svgEntry = this.pageCache.get(cacheKey);
    if (!svgEntry) {
      const { svg, text } = await this.parser.pageToSvg(buf, doc.pagePaths[page - 1], doc.meta.widthMM, doc.meta.heightMM);
      svgEntry = { svg, text };
      this.pageCache.set(cacheKey, svgEntry);
    }
    return { items: svgEntry.text };
  }

  private mmToPt(mm: number) {
    return (mm / 25.4) * 72.0;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: any;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), t]);
  }
}
