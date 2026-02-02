import { Controller, Get, Query, Post, Body, Param, Res } from '@nestjs/common';
import { AdbService } from './adb.service';
import * as path from 'path';

@Controller('adb')
export class AdbController {
  constructor(private readonly adbService: AdbService) {}

  @Get('devices')
  async getDevices() {
    return { devices: await this.adbService.getDevices() };
  }

  @Get('packages')
  async listPackages(@Query('device') device?: string) {
    return { packages: await this.adbService.listPackages(device) };
  }

  @Get('paths')
  async getApkPaths(@Query('package') packageName: string, @Query('device') device?: string) {
    return { paths: await this.adbService.getApkPaths(packageName, device) };
  }

  @Post('pull-package')
  async pullPackage(@Body() body: { packageName: string; device?: string }) {
    const zipPath = await this.adbService.pullPackage(body.packageName, body.device);
    const filename = path.basename(zipPath);
    return { zipFilename: filename };
  }

  @Post('bundle-single')
  async bundleSingle(@Body() body: { packageName: string; device?: string }) {
    const zipPath = await this.adbService.bundleToSingle(body.packageName, body.device);
    const filename = path.basename(zipPath);
    return { zipFilename: filename };
  }

  @Post('decompile')
  async decompile(@Body() body: { packageName: string; device?: string }) {
    const zipPath = await this.adbService.decompileApk(body.packageName, body.device);
    const filename = path.basename(zipPath);
    return { zipFilename: filename };
  }

  @Post('process-mitm')
  async processMitm(@Body() body: { packageName: string; zipFilename?: string; device?: string }) {
    let zipPath: string;
    if (body.zipFilename) {
      zipPath = `/tmp/${body.zipFilename}`;
    } else {
      // Pull first
      zipPath = await this.adbService.pullPackage(body.packageName, body.device);
    }
    const newZipPath = await this.adbService.processWithMitm(body.packageName, zipPath);
    const newFilename = path.basename(newZipPath);
    return { zipFilename: newFilename };
  }

  @Get('download/:filename')
  async downloadApk(@Param('filename') filename: string, @Res() res) {
    const filePath = `/tmp/${filename}`;
    res.download(filePath);
  }
}
