import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

export interface OfdMetadata {
  pages: number;
  widthMM: number;
  heightMM: number;
  title?: string;
  author?: string;
  creationDate?: string;
  textExtractable: boolean;
}

export interface ParsedDoc {
  meta: OfdMetadata;
  pagePaths: string[]; // relative paths inside zip
}

export interface PageTextItem {
  text: string;
  x: number; // mm
  y: number; // mm
  size: number; // pt
}

export class OfdParser {
  private xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true,
    parseAttributeValue: true,
  });

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

    const docFile = zip.file(this.normalizeZipPath(docPath));
    if (!docFile) throw new Error(`Invalid OFD: Document not found at ${docPath}`);
    const docXml = await docFile.async('text');
    const docJson = this.xml.parse(docXml);

    const common = docJson.Document?.CommonData || docJson.CommonData;
    if (!common) throw new Error('Invalid OFD: missing CommonData');
    const pageArea = common.PageArea || {};
    const physicalBox = pageArea.PhysicalBox || pageArea.PhysicalBoxs || '0 0 210 297';
    const [x0, y0, w, h] = ('' + physicalBox).split(/\s+/).map((v: string) => parseFloat(v));
    const widthMM = isFinite(w) ? w : 210;
    const heightMM = isFinite(h) ? h : 297;

    // Pages list can be in Document.Pages.Page[] with BaseLoc
    const pagesNode = docJson.Document?.Pages?.Page || docJson.Pages?.Page || [];
    const pagesArr = Array.isArray(pagesNode) ? pagesNode : [pagesNode];
    const pagePaths: string[] = pagesArr
      .filter(Boolean)
      .map((p: any) => p['@_BaseLoc'] || p['@_baseLoc'] || p['@_base'])
      .filter(Boolean)
      .map((p: string) => this.normalizeZipPath(p));

    if (pagePaths.length === 0) throw new Error('Invalid OFD: no pages');

    const meta: OfdMetadata = {
      pages: pagePaths.length,
      widthMM,
      heightMM,
      title,
      author,
      creationDate,
      textExtractable: true, // we attempt to parse text
    };

    return { meta, pagePaths };
  }

  async pageToSvg(buffer: Buffer, pagePath: string, widthMM: number, heightMM: number) {
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
      `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMM}mm" height="${heightMM}mm" viewBox="0 0 ${widthMM} ${heightMM}" style="background:white">` +
      svgTexts.join('') +
      `</svg>`;

    return { svg, text: extractedText };
  }

  private normalizeZipPath(p: string) {
    return p.replace(/^\.\//, '').replace(/^\//, '');
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
