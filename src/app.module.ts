import { Module, OnModuleInit } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { OfdModule } from './ofd/ofd.module';
import { ensureSampleData } from './ofd/sample';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveRoot: '/',
    }),
    OfdModule,
  ],
})
export class AppModule implements OnModuleInit {
  async onModuleInit() {
    await ensureSampleData();
  }
}
