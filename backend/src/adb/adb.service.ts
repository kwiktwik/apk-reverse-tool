import { Injectable } from '@nestjs/common';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { LogsGateway } from '../logs/logs.gateway';

const archiver = require('archiver');

const execAsync = promisify(exec);

@Injectable()
export class AdbService {
  constructor(private logsGateway: LogsGateway) {}

  private async ensureSaiCli(): Promise<string> {
    const saiPath = '/tmp/sai-cli.jar';
    if (fs.existsSync(saiPath)) {
      return saiPath;
    }
    this.logsGateway.emitLog('system', 'Downloading SAI CLI...');
    const url = 'https://github.com/Aefyr/SAI/releases/download/3.10/sai-cli.jar';
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(saiPath);
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          this.logsGateway.emitLog('system', 'SAI CLI downloaded.');
          resolve(saiPath);
        });
      }).on('error', (err) => {
        fs.unlink(saiPath, () => {});
        reject(err);
      });
    });
  }

  private async ensureApktool(): Promise<string> {
    const apktoolPath = '/tmp/apktool.jar';
    if (fs.existsSync(apktoolPath)) {
      return apktoolPath;
    }
    this.logsGateway.emitLog('system', 'Downloading Apktool...');
    const url = 'https://bitbucket.org/iBotPeaches/apktool/downloads/apktool_2.9.3.jar';
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(apktoolPath);
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          this.logsGateway.emitLog('system', 'Apktool downloaded.');
          resolve(apktoolPath);
        });
      }).on('error', (err) => {
        fs.unlink(apktoolPath, () => {});
        reject(err);
      });
    });
  }
  async getDevices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('adb devices');
      const lines = stdout.trim().split('\n').slice(1); // skip first line
      return lines.filter(line => line.includes('device')).map(line => line.split('\t')[0]);
    } catch (error) {
      return [];
    }
  }

  async listPackages(device?: string): Promise<string[]> {
    try {
      const deviceFlag = device ? `-s ${device}` : '';
      const { stdout } = await execAsync(`adb ${deviceFlag} shell pm list packages -3`);
      return stdout.trim().split('\n').map(line => line.replace('package:', ''));
    } catch (error) {
      return [];
    }
  }

  async getApkPaths(packageName: string, device?: string): Promise<string[]> {
    try {
      const deviceFlag = device ? `-s ${device}` : '';
      const { stdout } = await execAsync(`adb ${deviceFlag} shell pm path ${packageName}`);
      return stdout.trim().split('\n').map(line => line.replace('package:', ''));
    } catch (error) {
      return [];
    }
  }

  async pullApk(apkPath: string, packageName: string, device?: string): Promise<string> {
    const deviceFlag = device ? `-s ${device}` : '';
    const outputPath = `/tmp/${packageName}_${Date.now()}.apk`;
    await execAsync(`adb ${deviceFlag} pull ${apkPath} ${outputPath}`);
    return outputPath;
  }

  async pullPackage(packageName: string, device?: string): Promise<string> {
    this.logsGateway.emitLog(packageName, 'Fetching APK paths...');
    const paths = await this.getApkPaths(packageName, device);
    this.logsGateway.emitLog(packageName, `Found ${paths.length} APK(s).`);
    const pulledPaths: string[] = [];
    for (const apkPath of paths) {
      this.logsGateway.emitLog(packageName, `Pulling ${apkPath}...`);
      const pulledPath = await this.pullApk(apkPath, packageName, device);
      pulledPaths.push(pulledPath);
      this.logsGateway.emitLog(packageName, `Pulled ${path.basename(pulledPath)}.`);
    }
    const zipPath = `/tmp/${packageName}_${Date.now()}.zip`;
    this.logsGateway.emitLog(packageName, 'Zipping APKs...');
    await this.createZip(pulledPaths, zipPath, packageName);
    this.logsGateway.emitLog(packageName, 'APK pull completed.');
    return zipPath;
  }

  async bundleToSingle(packageName: string, device?: string): Promise<string> {
    this.logsGateway.emitLog(packageName, 'Starting bundle to single APK...');
    const paths = await this.getApkPaths(packageName, device);
    if (paths.length <= 1) {
      throw new Error('Not a split APK');
    }
    const tempDir = `/tmp/${packageName}_bundle_${Date.now()}`;
    fs.mkdirSync(tempDir);
    const pulledPaths: string[] = [];
    for (const apkPath of paths) {
      const pulledPath = await this.pullApk(apkPath, packageName, device);
      pulledPaths.push(pulledPath);
      // Copy to tempDir
      fs.copyFileSync(pulledPath, path.join(tempDir, path.basename(pulledPath)));
    }
    const saiPath = await this.ensureSaiCli();
    const outputApk = path.join(tempDir, `${packageName}_bundled.apk`);
    await execAsync(`java -jar ${saiPath} merge -i ${tempDir} -o ${outputApk}`);
    this.logsGateway.emitLog(packageName, 'Bundled to single APK.');
    const zipPath = `/tmp/${packageName}_bundled_${Date.now()}.zip`;
    await this.createZip([outputApk], zipPath, packageName);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return zipPath;
  }

  async decompileApk(packageName: string, device?: string): Promise<string> {
    this.logsGateway.emitLog(packageName, 'Starting APK decompilation...');
    const paths = await this.getApkPaths(packageName, device);
    let apkPath: string;
    if (paths.length > 1) {
      // Bundle first
      this.logsGateway.emitLog(packageName, 'Bundling split APK first...');
      const bundledZip = await this.bundleToSingle(packageName, device);
      const tempDir = `/tmp/${packageName}_decomp_${Date.now()}`;
      fs.mkdirSync(tempDir);
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(bundledZip);
      zip.extractAllTo(tempDir);
      const apkFile = fs.readdirSync(tempDir).find(f => f.endsWith('.apk'));
      if (!apkFile) throw new Error('Bundled APK not found');
      apkPath = path.join(tempDir, apkFile);
      apkPath = path.join(tempDir, apkPath);
    } else {
      apkPath = await this.pullApk(paths[0], packageName, device);
    }
    const apktoolPath = await this.ensureApktool();
    const outputDir = `/tmp/${packageName}_decompiled_${Date.now()}`;
    fs.mkdirSync(outputDir);
    await execAsync(`java -jar ${apktoolPath} d ${apkPath} -o ${outputDir} -f`);
    this.logsGateway.emitLog(packageName, 'Decompiled APK.');
    const zipPath = `/tmp/${packageName}_decompiled_${Date.now()}.zip`;
    await this.createZipFromDir(outputDir, zipPath);
    fs.rmSync(outputDir, { recursive: true, force: true });
    return zipPath;
  }

  private async createZipFromDir(dirPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(dirPath, false);
      archive.finalize();
    });
  }

  private async createZip(filePaths: string[], outputPath: string, packageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', () => resolve());
      archive.on('error', reject);
      archive.pipe(output);
      filePaths.forEach((filePath) => {
        archive.file(filePath, { name: path.basename(filePath) });
      });
      archive.finalize();
    });
  }

  async processWithMitm(packageName: string, zipPath: string): Promise<string> {
    this.logsGateway.emitLog(packageName, 'Starting MITM injection...');
    // Unzip the pulled APKs
    const tempDir = `/tmp/${packageName}_mitm_${Date.now()}`;
    fs.mkdirSync(tempDir);
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tempDir);
    this.logsGateway.emitLog(packageName, 'Extracted APKs.');
    const apkFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.apk')).map(f => path.join(tempDir, f));
    if (apkFiles.length === 0) {
      throw new Error('No APK files found');
    }
    // Run apk-mitm with all APKs
    const outputApk = path.join(tempDir, `${packageName}_mitm.apk`);
    await this.runApkMitm(apkFiles, outputApk, packageName);
    this.logsGateway.emitLog(packageName, 'MITM injection completed.');
    // Zip the single output APK
    const newZipPath = `/tmp/${packageName}_mitm_${Date.now()}.zip`;
    await this.createZip([outputApk], newZipPath, packageName);
    this.logsGateway.emitLog(packageName, 'Zipping processed APK...');
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    return newZipPath;
  }

  private async runApkMitm(inputPaths: string[], outputPath: string, packageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['apk-mitm', ...inputPaths, '-o', outputPath];
      const child = spawn('npx', args, { stdio: 'pipe' });
      child.stdout.on('data', (data) => {
        this.logsGateway.emitLog(packageName, data.toString());
      });
      child.stderr.on('data', (data) => {
        this.logsGateway.emitLog(packageName, data.toString());
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`apk-mitm exited with code ${code}`));
      });
    });
  }
}
