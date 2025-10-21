import { Controller, Get, Query, Res, BadRequestException, Post, UploadedFile, UseInterceptors, StreamableFile } from '@nestjs/common';
import { Response } from 'express';
import { OfdService } from './ofd.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileService } from './file.service';

@Controller()
export class OfdController {
  constructor(private readonly ofd: OfdService, private readonly files: FileService) {}

  @Get('/api/ofd/metadata')
  async metadata(@Query('file') file: string) {
    try {
      const meta = await this.ofd.getMetadata(file);
      return meta;
    } catch (e: any) {
      if (e?.status) throw e;
      throw new BadRequestException(e?.message || 'Failed to parse OFD');
    }
  }

  @Get('/api/ofd/page')
  async page(
    @Query('file') file: string,
    @Query('page') page: string,
    @Query('format') format: string,
    @Query('scale') scale: string,
    @Res() res: Response,
  ) {
    try {
      const p = parseInt(page || '1');
      const fmt = (format || 'svg').toLowerCase();
      if (!['svg', 'png', 'pdf'].includes(fmt)) throw new BadRequestException('Invalid format');
      const sc = scale ? parseFloat(scale) : 1;
      const data = await this.ofd.getPage(file, p, fmt as any, sc);
      res.setHeader('Content-Type', data.contentType);
      res.send(data.body);
    } catch (e: any) {
      if (e?.status) throw e;
      throw new BadRequestException(e?.message || 'Failed to render page');
    }
  }

  @Get('/api/ofd/text')
  async text(@Query('file') file: string, @Query('page') page: string) {
    try {
      const p = parseInt(page || '1');
      const data = await this.ofd.getText(file, p);
      return { page: p, items: data.items };
    } catch (e: any) {
      if (e?.status) throw e;
      throw new BadRequestException(e?.message || 'Failed to extract text');
    }
  }

  @Post('/api/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!/\.(ofd)$/i.test(file.originalname)) {
      throw new BadRequestException('Only .ofd files are allowed');
    }
    const id = await this.files.saveUpload(file.buffer, file.originalname);
    return { id, file: `id:${id}` };
  }

  @Get('/api/ofd/raw')
  async raw(@Query('file') file: string) {
    const stream = this.files.createReadStream(file);
    return new StreamableFile(stream, {
      disposition: `attachment; filename="${encodeURIComponent(file.split('/').pop() || 'file.ofd')}"`,
      type: 'application/ofd',
    });
  }

  @Get('/url')
  async urlPage(@Res() res: Response) {
    // Serve the viewer HTML file
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile('viewer.html', { root: process.cwd() + '/public' });
  }
}
