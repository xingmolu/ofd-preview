import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import path from 'path';
import {
  OfdRenderingStrategy,
  ParsedDoc,
  OfdMetadata,
  RenderedPage,
  PageTextItem,
} from '../types';

export class BasicOfdStrategy implements OfdRenderingStrategy {
  readonly name = 'basic';
  private xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true,
    parseAttributeValue: true,
  });

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async parse(buffer: Buffer): Promise<ParsedDoc> {
    const zip = await JSZip.loadAsync(buffer);
    const ofdXmlFile = zip.file(/(^|\/)OFD\.xml$/i)[0];
    if (!ofdXmlFile) throw new Error('Invalid OFD: missing OFD.xml');
    const ofdXml = await ofdXmlFile.async('text');
    const ofdJson = this.xml.parse(ofdXml);

    const docBody = ofdJson.OFD?.DocBody || ofdJson.DocBody || ofdJson.ofd?.DocBody;
    if (!docBody) throw new Error('Invalid OFD: missing DocBody');

    const docInfo = docBody.DocInfo || {};
    const title = docInfo.Title || undefined;
    const author = docInfo.Author || undefined;
    const creationDate = docInfo.CreationDate || undefined;

    const docPath = docBody.Document || docBody.DocRoot || docBody.docRoot;
    if (!docPath) throw new Error('Invalid OFD: missing Document root path');

    const documentPath = this.normalizeZipPath(docPath);
    const docFile = zip.file(documentPath);
    if (!docFile) throw new Error(`Invalid OFD: Document not found at ${docPath}`);
    const docXml = await docFile.async('text');
    const docJson = this.xml.parse(docXml);

    const common = docJson.Document?.CommonData || docJson.CommonData;
    if (!common) throw new Error('Invalid OFD: missing CommonData');
    const pageArea = common.PageArea || {};
    const physicalBox = pageArea.PhysicalBox || pageArea.PhysicalBoxs || '0 0 210 297';
    const [x0, y0, w, h] = (`${physicalBox}`).split(/\s+/).map((v: string) => parseFloat(v));
    const widthMM = Number.isFinite(w) ? w : 210;
    const heightMM = Number.isFinite(h) ? h : 297;
    void x0; // unused in basic strategy
    void y0;

    const pagesNode = docJson.Document?.Pages?.Page || docJson.Pages?.Page || [];
    const pagesArr = Array.isArray(pagesNode) ? pagesNode : [pagesNode];
    const docDir = this.getDocDirectory(documentPath);
    const pagePaths: string[] = pagesArr
      .filter(Boolean)
      .map((p: any) => this.resolvePagePath(p, docDir))
      .filter((p): p is string => Boolean(p));

    if (pagePaths.length === 0) throw new Error('Invalid OFD: no pages');

    const meta: OfdMetadata = {
      pages: pagePaths.length,
      widthMM,
      heightMM,
      title,
      author,
      creationDate,
      textExtractable: true,
    };

    return {
      meta,
      engine: this.name,
      pageRefs: pagePaths,
      capabilities: {
        text: true,
        vector: false,
        images: false,
        annotations: false,
        signatures: false,
      },
      internal: {
        documentPath: this.normalizeZipPath(docPath),
      },
    };
  }

  async renderPage(buffer: Buffer, doc: ParsedDoc, pageIndex: number): Promise<RenderedPage> {
    const pagePath = doc.pageRefs[pageIndex];
    if (!pagePath) {
      throw new Error(`Page ${pageIndex + 1} not found`);
    }

    const zip = await JSZip.loadAsync(buffer);
    const pageFile = zip.file(this.normalizeZipPath(pagePath));
    if (!pageFile) throw new Error(`Page not found: ${pagePath}`);
    const pageXml = await pageFile.async('text');
    const pageJson = this.xml.parse(pageXml);

    const textObjects: any[] = [];
    const layers = pageJson.Page?.Content?.Layer || pageJson.Content?.Layer || [];
    const layersArr = Array.isArray(layers) ? layers : [layers];
    for (const layer of layersArr) {
      const to = layer?.TextObject || [];
      const arr = Array.isArray(to) ? to : [to];
      for (const obj of arr) textObjects.push(obj);
    }

    const svgTexts: string[] = [];
    const extractedText: PageTextItem[] = [];

    for (const obj of textObjects) {
      const size = obj['@_Size'] ? parseFloat(obj['@_Size']) : 12;
      const codes = obj.TextCode ? (Array.isArray(obj.TextCode) ? obj.TextCode : [obj.TextCode]) : [];
      for (const code of codes) {
        const x = code['@_X'] !== undefined ? parseFloat(code['@_X']) : 0;
        const y = code['@_Y'] !== undefined ? parseFloat(code['@_Y']) : 0;
        const content = (code['#text'] ?? '').toString();
        const esc = this.escapeXml(content);
        svgTexts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="#000">${esc}</text>`);
        extractedText.push({ text: content, x, y, size });
      }
    }

    if (svgTexts.length === 0) {
      svgTexts.push(`<text x="20" y="40" font-size="14" fill="#c00">This simple renderer supports only basic TextObject/TextCode. No renderable text found on this page.</text>`);
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${doc.meta.widthMM}mm" height="${doc.meta.heightMM}mm" viewBox="0 0 ${doc.meta.widthMM} ${doc.meta.heightMM}" style="background:white">` +
      svgTexts.join('') +
      `</svg>`;

    return { svg, text: extractedText };
  }

  private getDocDirectory(p: string) {
    const normalized = this.normalizeZipPath(p);
    const idx = normalized.lastIndexOf('/');
    return idx === -1 ? '' : normalized.substring(0, idx + 1);
  }

  private resolvePagePath(pageNode: any, docDir: string): string | undefined {
    if (!pageNode) return undefined;
    const candidates: (string | undefined)[] = [
      pageNode['@_BaseLoc'] || pageNode['@_baseLoc'] || pageNode['@_base'],
      pageNode['@_File'] || pageNode['@_file'],
    ];

    if (typeof pageNode.Content === 'string') {
      candidates.push(pageNode.Content);
    } else if (pageNode.Content?.['@_BaseLoc']) {
      candidates.push(pageNode.Content['@_BaseLoc']);
    }

    for (const candidate of candidates) {
      const resolved = this.normalizePageReference(candidate, docDir);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private normalizePageReference(value: string | undefined, docDir: string): string | undefined {
    if (!value) return undefined;
    const trimmed = `${value}`.trim();
    if (!trimmed) return undefined;
    let normalized = this.normalizeZipPath(trimmed);
    if (!docDir) return normalized;
    const docDirNormalized = docDir.endsWith('/') ? docDir : `${docDir}/`;
    if (normalized.startsWith(docDirNormalized) || normalized === docDir.slice(0, -1)) {
      return normalized;
    }
    return this.normalizeZipPath(path.posix.join(docDirNormalized, normalized));
  }

  private normalizeZipPath(p: string) {
    const normalized = path.posix.normalize(`${p}`);
    return normalized.replace(/^\.\//, '').replace(/^\//, '');
  }

  private escapeXml(s: string) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
