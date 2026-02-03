import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { ApkService } from './apk.service';

@Controller('apk')
export class ApkController {
    constructor(private readonly apkService: ApkService) { }

    @Post('merge')
    async mergeApk(@Body() body: { inputPath: string; outputPath: string }) {
        if (!body.inputPath || !body.outputPath) {
            throw new HttpException('inputPath and outputPath are required', HttpStatus.BAD_REQUEST);
        }
        try {
            const result = await this.apkService.mergeApks(body.inputPath, body.outputPath);
            return { success: true, path: result };
        } catch (error) {
            console.error(error);
            throw new HttpException(error.message || 'Failed to merge APKs', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}
