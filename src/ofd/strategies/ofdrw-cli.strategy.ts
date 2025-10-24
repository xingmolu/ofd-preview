import { spawn } from 'child_process';
import { promises as fsp, existsSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  OfdRenderingStrategy,
  ParsedDoc,
  RenderedPage,
  PageTextItem,
  OfdDocumentCapabilities,
  OfdMetadata,
} from '../types';

interface CliStrategyOptions {
  cliPath?: string;
  timeoutMs?: number;
  keepArtifacts?: boolean;
}

interface CliMetadataResponse {
  meta: OfdMetadata;
  capabilities?: Partial<OfdDocumentCapabilities>;
  pageRefs?: string[];
}

export class OfdrwCliStrategy implements OfdRenderingStrategy {
  readonly name = 'ofdrw-cli';
  private cliPath?: string;
  private timeoutMs: number;
  private keepArtifacts: boolean;

  constructor(options: CliStrategyOptions = {}) {
    this.cliPath = options.cliPath || process.env.OFDRW_CLI || undefined;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.keepArtifacts = options.keepArtifacts ?? process.env.OFDRW_KEEP_ARTIFACTS === '1';
  }

  async isAvailable(): Promise<boolean> {
    if (!this.cliPath) return false;
    try {
      await fsp.access(this.cliPath);
      return true;
    } catch (err) {
      return false;
    }
  }

  async parse(buffer: Buffer): Promise<ParsedDoc> {
    const workdir = await this.makeWorkdir();
    try {
      const inputPath = path.join(workdir, 'input.ofd');
      await fsp.writeFile(inputPath, buffer);
      const { stdout } = await this.execCli(['metadata', inputPath], { cwd: workdir });
      const parsed = this.safeJson<CliMetadataResponse>(stdout.trim());
      if (!parsed?.meta) throw new Error('Invalid metadata response from OFDRW CLI');

      const doc: ParsedDoc = {
        meta: parsed.meta,
        engine: this.name,
        pageRefs: parsed.pageRefs && parsed.pageRefs.length > 0
          ? parsed.pageRefs
          : Array.from({ length: parsed.meta.pages }, (_, idx) => `page-${idx + 1}`),
        capabilities: {
          text: parsed.capabilities?.text ?? true,
          vector: parsed.capabilities?.vector ?? true,
          images: parsed.capabilities?.images ?? true,
          annotations: parsed.capabilities?.annotations ?? true,
          signatures: parsed.capabilities?.signatures ?? true,
        },
      };
      return doc;
    } finally {
      await this.cleanupWorkdir(workdir);
    }
  }

  async renderPage(buffer: Buffer, doc: ParsedDoc, pageIndex: number): Promise<RenderedPage> {
    const workdir = await this.makeWorkdir();
    try {
      const inputPath = path.join(workdir, 'input.ofd');
      await fsp.writeFile(inputPath, buffer);
      const outputBase = path.join(workdir, `output-${pageIndex + 1}`);
      const outputSvg = `${outputBase}.svg`;
      const outputJson = `${outputBase}.json`;

      const pageNumber = pageIndex + 1;
      await this.execCli([
        'render',
        '--page', String(pageNumber),
        '--format', 'svg',
        '--output', outputBase,
        inputPath,
      ], { cwd: workdir });

      const svg = await fsp.readFile(outputSvg, 'utf-8');
      let text: PageTextItem[] = [];
      if (await this.exists(outputJson)) {
        const rawText = await fsp.readFile(outputJson, 'utf-8');
        text = this.safeJson<PageTextItem[]>(rawText) ?? [];
      }

      if (!svg || svg.trim().length === 0) {
        throw new Error('OFDRW CLI did not produce SVG output');
      }

      return { svg, text };
    } finally {
      await this.cleanupWorkdir(workdir);
    }
  }

  private safeJson<T>(value: string): T | undefined {
    try {
      return JSON.parse(value) as T;
    } catch (err) {
      return undefined;
    }
  }

  private makeWorkdir(): Promise<string> {
    const dir = path.join(tmpdir(), `ofdrw-${randomUUID()}`);
    return fsp.mkdir(dir, { recursive: true }).then(() => dir);
  }

  private async cleanupWorkdir(dir: string) {
    if (this.keepArtifacts) return;
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
      // ignore clean-up errors
    }
  }

  private exists(p: string): Promise<boolean> {
    if (existsSync(p)) return Promise.resolve(true);
    return fsp.access(p).then(() => true).catch(() => false);
  }

  private execCli(args: string[], options: { cwd?: string } = {}) {
    if (!this.cliPath) {
      throw new Error('OFDRW CLI path is not configured');
    }

    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(this.cliPath as string, args, {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let finished = false;
      const timer = setTimeout(() => {
        if (!finished) {
          child.kill('SIGKILL');
          finished = true;
          reject(new Error(`OFDRW CLI timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err = new Error(`OFDRW CLI exited with code ${code}: ${stderr || stdout}`);
          reject(err);
        }
      });
    });
  }
}
