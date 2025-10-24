import { Buffer } from 'buffer';

export interface OfdMetadata {
  pages: number;
  widthMM: number;
  heightMM: number;
  title?: string;
  author?: string;
  creationDate?: string;
  textExtractable: boolean;
}

export interface OfdDocumentCapabilities {
  text: boolean;
  vector: boolean;
  images: boolean;
  annotations: boolean;
  signatures: boolean;
}

export interface ParsedDoc {
  meta: OfdMetadata;
  engine: string;
  pageRefs: string[];
  capabilities: OfdDocumentCapabilities;
  internal?: Record<string, unknown>;
}

export interface PageTextItem {
  text: string;
  x: number; // mm
  y: number; // mm
  size: number; // pt
  fontName?: string;
  fillColor?: string;
  rotation?: number;
}

export interface RenderedPage {
  svg: string;
  text: PageTextItem[];
}

export interface OfdRenderingStrategy {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  parse(buffer: Buffer): Promise<ParsedDoc>;
  renderPage(buffer: Buffer, doc: ParsedDoc, pageIndex: number): Promise<RenderedPage>;
}
