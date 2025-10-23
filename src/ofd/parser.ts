import { ParsedDoc, RenderedPage, OfdRenderingStrategy } from './types';
import { BasicOfdStrategy } from './strategies/basic.strategy';
import { OfdrwCliStrategy } from './strategies/ofdrw-cli.strategy';

interface ParserOptions {
  strategies?: OfdRenderingStrategy[];
  prefer?: string[];
  disableOfdrw?: boolean;
  ofdrwCliPath?: string;
  strategyTimeoutMs?: number;
}

export class OfdParser {
  private baseStrategies: OfdRenderingStrategy[];
  private availabilityCache?: OfdRenderingStrategy[];

  constructor(private readonly options: ParserOptions = {}) {
    if (options.strategies && options.strategies.length > 0) {
      this.baseStrategies = options.strategies;
    } else {
      const strategies: OfdRenderingStrategy[] = [];
      if (!options.disableOfdrw) {
        const cliStrategy = new OfdrwCliStrategy({
          cliPath: options.ofdrwCliPath,
          timeoutMs: options.strategyTimeoutMs,
        });
        strategies.push(cliStrategy);
      }
      strategies.push(new BasicOfdStrategy());
      this.baseStrategies = strategies;
    }
  }

  async parse(buffer: Buffer): Promise<ParsedDoc> {
    const strategies = await this.resolveAvailableStrategies();
    let lastError: unknown;
    const ordered = this.orderStrategies(strategies);

    for (const strategy of ordered) {
      try {
        const doc = await strategy.parse(buffer);
        if (!doc.engine) {
          doc.engine = strategy.name;
        }
        return doc;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('All OFD rendering strategies failed');
  }

  async renderPage(buffer: Buffer, doc: ParsedDoc, pageIndex: number): Promise<RenderedPage> {
    if (pageIndex < 0 || pageIndex >= doc.meta.pages) {
      throw new Error(`Invalid page index ${pageIndex}`);
    }

    const strategies = await this.resolveAvailableStrategies();
    const candidates = this.orderStrategies(strategies, doc.engine);
    let lastError: unknown;

    for (const strategy of candidates) {
      if (strategy.name !== doc.engine && doc.engine !== undefined) {
        // fallback only if the document engine matches or strategy claims compatibility
        if (!this.isStrategyCompatible(strategy, doc)) continue;
      }
      try {
        return await strategy.renderPage(buffer, doc, pageIndex);
      } catch (err) {
        lastError = err;
        if (strategy.name === doc.engine) {
          // try next fallback if available
          continue;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Unable to render page ${pageIndex + 1}`);
  }

  async pageToSvg(buffer: Buffer, docOrPath: ParsedDoc | string, pageIndex?: number): Promise<RenderedPage> {
    if (typeof docOrPath === 'string') {
      const doc = await this.parse(buffer);
      const index = doc.pageRefs.findIndex((ref) => ref === docOrPath);
      if (index === -1) {
        throw new Error(`Page not found: ${docOrPath}`);
      }
      return this.renderPage(buffer, doc, index);
    }

    if (typeof pageIndex !== 'number') {
      throw new Error('page index is required when passing ParsedDoc');
    }

    return this.renderPage(buffer, docOrPath, pageIndex);
  }

  private async resolveAvailableStrategies(): Promise<OfdRenderingStrategy[]> {
    if (this.availabilityCache) return this.availabilityCache;
    const available: OfdRenderingStrategy[] = [];
    for (const strategy of this.baseStrategies) {
      try {
        if (await strategy.isAvailable()) {
          available.push(strategy);
        }
      } catch (err) {
        // ignore availability errors, strategy treated as unavailable
      }
    }
    if (available.length === 0) {
      throw new Error('No OFD rendering strategies available');
    }
    this.availabilityCache = available;
    return available;
  }

  private orderStrategies(strategies: OfdRenderingStrategy[], preferred?: string): OfdRenderingStrategy[] {
    const preferList = this.options.prefer ?? [];
    const order: string[] = [];
    if (preferred) order.push(preferred);
    for (const item of preferList) {
      if (!order.includes(item)) order.push(item);
    }
    for (const strat of strategies) {
      if (!order.includes(strat.name)) order.push(strat.name);
    }
    const byName = new Map(strategies.map((s) => [s.name, s] as const));
    return order
      .map((name) => byName.get(name))
      .filter((s): s is OfdRenderingStrategy => Boolean(s));
  }

  private isStrategyCompatible(strategy: OfdRenderingStrategy, doc: ParsedDoc) {
    if (strategy.name === doc.engine) return true;
    if (strategy.name === 'basic') {
      // basic strategy requires embedded page references
      return doc.pageRefs.every((ref) => ref.endsWith('.xml'));
    }
    return true;
  }
}

export type { ParsedDoc } from './types';
export type { OfdMetadata, PageTextItem, RenderedPage, OfdDocumentCapabilities } from './types';
export { BasicOfdStrategy, OfdrwCliStrategy };
