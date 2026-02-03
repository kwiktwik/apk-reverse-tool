import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as util from 'util';
import * as os from 'os';

const exec = util.promisify(child_process.exec);

@Injectable()
export class ApkService {
    private readonly logger = new Logger(ApkService.name);
    private readonly CONST_DIR_TMP = '.mergeapks';
    private readonly CONST_FILE_TARGET_FILE = 'target';
    private readonly CONST_EXT_APK = '.apk';
    private readonly CONST_APK_FILE_APKTOOL_CONFIG = 'apktool.yml';

    async mergeApks(inputPath: string, outputPath: string): Promise<string> {
        const tmpDir = await this.createTmpDir();
        this.logger.log(`Created temp directory: ${tmpDir}`);

        try {
            // 1. Prepare inputs
            const apkFiles = await this.prepareApkFiles(inputPath, tmpDir);
            if (apkFiles.length < 1) {
                throw new Error('No APK files found in input path');
            }

            // 2. Unpack APKs
            for (let i = 0; i < apkFiles.length; i++) {
                await this.unpackApk(tmpDir, apkFiles[i]);
            }

            // 3. Merge Contents
            // Assume the first one is the base/main APK
            const mainApkDir = apkFiles[0].replace('.apk', '');
            const secondaryApkDirs = apkFiles.slice(1).map((f) => f.replace('.apk', ''));

            for (const secDir of secondaryApkDirs) {
                await this.mergeApkContents(path.join(tmpDir, mainApkDir), path.join(tmpDir, secDir));
            }

            // 4. Update Manifest and Cleanup
            const mainApkPath = path.join(tmpDir, mainApkDir);
            await this.deleteSignatureRelatedFiles(mainApkPath);
            await this.updateMainManifestFile(mainApkPath);

            // 5. Repack
            await this.packApk(tmpDir, mainApkDir);

            // 6. Zipalign
            const targetApk = path.join(tmpDir, this.CONST_FILE_TARGET_FILE + this.CONST_EXT_APK);
            await this.zipalignApk(targetApk);

            // 7. Copy to output
            await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.promises.copyFile(targetApk, outputPath);
            this.logger.log(`Merged APK saved to: ${outputPath}`);

            return outputPath;
        } catch (e) {
            this.logger.error('Error merging APKs', e);
            throw e;
        } finally {
            // Cleanup
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    }

    private async createTmpDir(): Promise<string> {
        const tmpPath = path.join(os.tmpdir(), 'merge-apk-' + Date.now());
        await fs.promises.mkdir(tmpPath, { recursive: true });
        return tmpPath;
    }

    private async prepareApkFiles(inputPath: string, tmpDir: string): Promise<string[]> {
        let files: string[] = [];
        if (fs.statSync(inputPath).isDirectory()) {
            files = fs.readdirSync(inputPath).filter((f) => f.endsWith('.apk'));
            // Sort to ensure base.apk comes first if possible, or simple alpha sort
            files.sort();
            // If "base.apk" exists, move it to front? usually split APKs are like base.apk, split_config.xx.apk
            // The python script relies on argument order. Here we rely on name.
            // Usually base.apk is the main one.
            const baseIndex = files.indexOf('base.apk');
            if (baseIndex > 0) {
                files.unshift(files.splice(baseIndex, 1)[0]);
            }

            const preparedFiles: string[] = [];
            for (const file of files) {
                const src = path.join(inputPath, file);
                const dest = path.join(tmpDir, file);
                await fs.promises.copyFile(src, dest);
                preparedFiles.push(file);
            }
            return preparedFiles;
        } else {
            // Single file? Makes no sense for merge. Assume directory for now as per user prompt.
            throw new Error('Input path must be a directory containing split APKs');
        }
    }

    private async unpackApk(tmpDir: string, apkFile: string) {
        this.logger.log(`Unpacking ${apkFile}...`);
        try {
            await exec(`apktool d -s "${apkFile}"`, { cwd: tmpDir });
            // remove original apk to save space? python script does it.
            await fs.promises.unlink(path.join(tmpDir, apkFile));
        } catch (e) {
            throw new Error(`Failed to unpack ${apkFile}: ${e.message}`);
        }
    }

    private async mergeApkContents(mainDir: string, secDir: string) {
        const dirsToMerge = ['assets', 'lib', 'res', 'unknown', 'kotlin'];
        for (const dir of dirsToMerge) {
            const src = path.join(secDir, dir);
            const dst = path.join(mainDir, dir);
            if (fs.existsSync(src)) {
                await this.mergeDirContents(src, dst);
            }
        }

        // Merge apktool.yml
        const srcConfig = path.join(secDir, this.CONST_APK_FILE_APKTOOL_CONFIG);
        const dstConfig = path.join(mainDir, this.CONST_APK_FILE_APKTOOL_CONFIG);
        if (fs.existsSync(srcConfig) && fs.existsSync(dstConfig)) {
            await this.mergeApktoolYml(srcConfig, dstConfig);
        }
    }

    private async mergeDirContents(src: string, dst: string) {
        if (!fs.existsSync(dst)) {
            await fs.promises.mkdir(dst, { recursive: true });
        }
        const entries = await fs.promises.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const dstPath = path.join(dst, entry.name);

            if (entry.isDirectory()) {
                await this.mergeDirContents(srcPath, dstPath);
            } else {
                if (!fs.existsSync(dstPath)) {
                    await fs.promises.copyFile(srcPath, dstPath);
                }
            }
        }
    }

    private async mergeApktoolYml(src: string, dst: string) {
        const srcContent = await fs.promises.readFile(src, 'utf-8');
        const dstContent = await fs.promises.readFile(dst, 'utf-8');

        const srcLines = srcContent.split('\n');
        const dstLines = dstContent.split('\n');

        const srcDoNotCompress = this.getDoNotCompressLines(srcLines);
        if (srcDoNotCompress.length === 0) return;

        // Insert into dst
        const { startIndex, endIndex, lines: dstDoNotCompress } = this.getDoNotCompressRange(dstLines);

        // Combine unique
        const combined = new Set([...dstDoNotCompress, ...srcDoNotCompress]);
        const sorted = Array.from(combined).sort();

        // Reconstruct
        const newLines = [...dstLines];
        // If we found a block, replace it. If not, we might need to add it?
        // Python script logic assumes block exists if it parses.
        if (startIndex !== -1 && endIndex !== -1) {
            newLines.splice(startIndex, endIndex - startIndex + 1, ...sorted);
        } else {
            // If target has no doNotCompress, maybe append? 
            // For simplicity, if target lacks it, we assume we don't need to add it strictly or it's complex.
            // But usually apktool.yml has it.
        }

        await fs.promises.writeFile(dst, newLines.join('\n'));
    }

    private getDoNotCompressLines(lines: string[]): string[] {
        const result: string[] = [];
        let inside = false;
        for (const line of lines) {
            if (line.trim().startsWith('doNotCompress:')) {
                inside = true;
                continue;
            }
            if (inside) {
                if (line.trim().startsWith('- ')) {
                    result.push(line); // Keep indentation
                } else if (line.trim() !== '' && !line.startsWith('#')) {
                    // End of block
                    break;
                }
            }
        }
        return result;
    }

    private getDoNotCompressRange(lines: string[]) {
        let startIndex = -1;
        let endIndex = -1;
        const extracted: string[] = [];
        let inside = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!inside && line.trim().startsWith('doNotCompress:')) {
                inside = true;
                // The items start after this line usually
                continue;
            }
            if (inside) {
                if (line.trim().startsWith('- ')) {
                    if (startIndex === -1) startIndex = i;
                    endIndex = i;
                    extracted.push(line);
                } else if (line.trim() !== '' && !line.trim().startsWith('#')) {
                    // End of block
                    break;
                }
            }
        }
        return { startIndex, endIndex, lines: extracted };
    }

    private async deleteSignatureRelatedFiles(apkDir: string) {
        const metaInf = path.join(apkDir, 'original', 'META-INF');
        if (fs.existsSync(metaInf)) {
            const files = await fs.promises.readdir(metaInf);
            for (const file of files) {
                if (file.endsWith('.RSA') || file.endsWith('.SF') || file === 'MANIFEST.MF') {
                    await fs.promises.unlink(path.join(metaInf, file));
                }
            }
        }
    }

    private async updateMainManifestFile(apkDir: string) {
        const manifestPath = path.join(apkDir, 'AndroidManifest.xml');
        if (!fs.existsSync(manifestPath)) return;

        let data = await fs.promises.readFile(manifestPath, 'utf-8');

        data = data.replace(/ android:isSplitRequired="true" /g, ' ');
        data = data.replace(/<meta-data android:name="com.android.vending.splits.required" android:value="true"\/>/g, '');
        data = data.replace(/<meta-data android:name="com.android.vending.splits" android:resource="@xml\/splits0"\/>/g, '');
        data = data.replace(/android:value="STAMP_TYPE_DISTRIBUTION_APK"/g, 'android:value="STAMP_TYPE_STANDALONE_APK"');

        await fs.promises.writeFile(manifestPath, data);
    }

    private async packApk(tmpDir: string, apkDirName: string) {
        this.logger.log('Repacking APK...');
        try {
            await exec(`apktool b "${apkDirName}"`, { cwd: tmpDir });
        } catch (e) {
            throw new Error(`Failed to pack APK: ${e.message}`);
        }

        const distDir = path.join(tmpDir, apkDirName, 'dist');
        const builtApk = (await fs.promises.readdir(distDir))[0]; // Take the first file in dist
        if (!builtApk) throw new Error('Result APK not found in dist');

        const target = path.join(tmpDir, this.CONST_FILE_TARGET_FILE + this.CONST_EXT_APK);
        await fs.promises.copyFile(path.join(distDir, builtApk), target);
    }

    private async zipalignApk(apkPath: string) {
        this.logger.log('Zipaligning APK...');
        const alignedPath = apkPath.replace('.apk', '-aligned.apk');
        try {
            // -p: 4kb page-align .so, -f: overwrite, -v: verbose, 4: alignment
            await exec(`zipalign -p -f 4 "${apkPath}" "${alignedPath}"`);
            await fs.promises.rename(alignedPath, apkPath);
        } catch (e) {
            // If zipalign fails, we might still return the unaligned one but warn?
            // Or throw.
            throw new Error(`Failed to zipalign: ${e.message}`);
        }
    }
}
