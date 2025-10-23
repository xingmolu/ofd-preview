import { Module } from '@nestjs/common';
import { OfdController } from './ofd.controller';
import { OfdService } from './ofd.service';
import { FileService } from './file.service';

@Module({
  controllers: [OfdController],
  providers: [OfdService, FileService],
  exports: [OfdService],
})
export class OfdModule {}
