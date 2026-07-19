// scripts/download-pg.ts
// PostgreSQL 便携版二进制下载脚本（设计文档 §6.5 AGE 兼容性策略）
//
// 用途：
// - 打包前从 EnterpriseDB 下载 PG 18.4 和 17.10 便携版二进制
// - 解压到 resources/pg/<version>/ 目录
// - electron-builder.yml 的 extraResources 会把该目录打包到安装包
//
// 用法：
//   pnpm download:pg              # 下载 18.4 和 17.10 两个版本
//   pnpm download:pg -- 18.4      # 仅下载 18.4
//   pnpm download:pg -- 17.10     # 仅下载 17.10
//
// 来源：https://www.enterprisedb.com/download-postgresql-binaries
// 直链格式：https://get.enterprisedb.com/postgresql/postgresql-<version>-1-windows-x64-binaries.zip
//
// 注意：
// - 仅 Windows x64 平台（设计文档 §1.1 Windows-only）
// - 下载约 200MB / 版本，需要联网
// - 已存在 postgres.exe 时跳过下载，避免重复下载

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// 项目根目录（脚本位于 scripts/，所以根目录是上一级）
const ROOT = resolve(import.meta.dirname, '..');
// PG 二进制存放目录
const PG_DIR = join(ROOT, 'resources', 'pg');

/**
 * 下载 EnterpriseDB PG 便携版 zip
 *
 * EnterpriseDB 官方提供 Windows x64 binaries zip 包，包含 initdb/postgres/pg_ctl 等完整二进制
 *
 * @param version PG 版本号（如 18.4、17.10）
 * @returns 下载到临时目录的 zip 文件路径
 */
async function downloadPgZip(version: string): Promise<string> {
  const url = `https://get.enterprisedb.com/postgresql/postgresql-${version}-1-windows-x64-binaries.zip`;
  const zipPath = join(tmpdir(), `postgresql-${version}-win-x64.zip`);

  console.log(`[download-pg] 开始下载 PG ${version}`);
  console.log(`[download-pg] URL: ${url}`);
  console.log(`[download-pg] 临时文件: ${zipPath}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  console.log(`[download-pg] 文件大小: ${(contentLength / 1024 / 1024).toFixed(2)} MB`);

  // 用 pipeline 把 ReadableStream 写到文件（自动背压处理）
  const fileStream = createWriteStream(zipPath);
  await pipeline(Readable.fromWeb(response.body), fileStream);

  const actualSize = statSync(zipPath).size;
  if (contentLength && actualSize !== contentLength) {
    throw new Error(`下载不完整：期望 ${contentLength} 字节，实际 ${actualSize} 字节`);
  }

  console.log(`[download-pg] 下载完成，大小 ${(actualSize / 1024 / 1024).toFixed(2)} MB`);
  return zipPath;
}

/**
 * 解压 zip 到目标目录
 *
 * Windows 上调用 PowerShell Expand-Archive（避免引入 unzipper 依赖）
 *
 * @param zipPath zip 文件路径
 * @param destDir 解压目标目录（已存在）
 * @returns 解压完成的 Promise
 */
function unzipWithPowerShell(zipPath: string, destDir: string): Promise<void> {
  console.log(`[download-pg] 解压到临时目录: ${destDir}`);

  // PowerShell Expand-Archive 是 Windows 内置命令，无需额外依赖
  // -Force 覆盖已有文件
  // -LiteralPath 避免路径中特殊字符被解释
  const psScript = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`;
  const result = spawn('powershell', ['-NoProfile', '-Command', psScript], { stdio: 'inherit' });

  return new Promise<void>((resolvePromise, reject) => {
    result.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`PowerShell Expand-Archive 失败，退出码 ${code}`));
      }
    });
    result.on('error', (err) => reject(err));
  });
}

/**
 * 把 EnterpriseDB zip 解压后的 postgresql-<version> 目录重命名为标准目录
 *
 * EnterpriseDB zip 解压后是 postgresql-<version> 形式（如 postgresql-18.4-1-windows-x64-binaries），
 * 重命名为 resources/pg/<version>，让 pg-installer.ts 的 getPgBinaryPath() 能找到
 *
 * @param version PG 版本号
 * @param zipPath zip 文件路径
 */
async function extractAndInstall(version: string, zipPath: string): Promise<void> {
  // 临时解压目录（解压完成后删除）
  const tmpExtractDir = join(tmpdir(), `pg-extract-${version}-${Date.now()}`);
  mkdirSync(tmpExtractDir, { recursive: true });

  try {
    unzipWithPowerShell(zipPath, tmpExtractDir);

    // EnterpriseDB 解压后顶层是 pgsql/ 目录，包含 bin/lib/share 等子目录
    // 标准结构：resources/pg/<version>/bin/postgres.exe
    const pgsqlDir = join(tmpExtractDir, 'pgsql');
    if (!existsSync(pgsqlDir)) {
      throw new Error(`解压后未找到 pgsql 目录：${pgsqlDir}`);
    }

    const versionDir = join(PG_DIR, version);
    if (existsSync(versionDir)) {
      console.log(`[download-pg] 清理旧版本目录: ${versionDir}`);
      rmSync(versionDir, { recursive: true, force: true });
    }
    mkdirSync(PG_DIR, { recursive: true });

    console.log(`[download-pg] 移动 pgsql → ${versionDir}`);
    renameSync(pgsqlDir, versionDir);

    // 验证关键二进制是否存在
    const postgresExe = join(versionDir, 'bin', 'postgres.exe');
    const initdbExe = join(versionDir, 'bin', 'initdb.exe');
    const pgCtlExe = join(versionDir, 'bin', 'pg_ctl.exe');

    if (!existsSync(postgresExe)) throw new Error(`缺少 postgres.exe: ${postgresExe}`);
    if (!existsSync(initdbExe)) throw new Error(`缺少 initdb.exe: ${initdbExe}`);
    if (!existsSync(pgCtlExe)) throw new Error(`缺少 pg_ctl.exe: ${pgCtlExe}`);

    console.log(`[download-pg] PG ${version} 安装完成`);
    console.log(`[download-pg]   postgres: ${postgresExe}`);
    console.log(`[download-pg]   initdb:   ${initdbExe}`);
    console.log(`[download-pg]   pg_ctl:   ${pgCtlExe}`);
  } finally {
    // 清理临时目录（无论成功失败都清理）
    if (existsSync(tmpExtractDir)) {
      rmSync(tmpExtractDir, { recursive: true, force: true });
    }
    if (existsSync(zipPath)) {
      rmSync(zipPath);
    }
  }
}

/**
 * 检查指定版本的 PG 二进制是否已安装
 *
 * 通过 postgres.exe 是否存在判断（避免重复下载）
 *
 * @param version PG 版本号
 * @returns true=已安装，跳过下载
 */
function isPgInstalled(version: string): boolean {
  const postgresExe = join(PG_DIR, version, 'bin', 'postgres.exe');
  const installed = existsSync(postgresExe);
  if (installed) {
    console.log(`[download-pg] PG ${version} 已安装，跳过下载`);
  }
  return installed;
}

/**
 * 安装单个 PG 版本
 *
 * 流程：
 * 1. 检查是否已安装（避免重复下载）
 * 2. 下载 zip 到临时目录
 * 3. 解压并移动到 resources/pg/<version>/
 * 4. 验证关键二进制
 *
 * @param version PG 版本号（如 18.4、17.10）
 */
async function installVersion(version: string): Promise<void> {
  if (isPgInstalled(version)) {
    return;
  }
  const zipPath = await downloadPgZip(version);
  await extractAndInstall(version, zipPath);
}

async function main(): Promise<void> {
  // 从命令行参数读取版本号，未指定则安装两个版本
  // 用法：pnpm download:pg -- 18.4
  const args = process.argv.slice(2);
  const versions = args.length > 0 ? args : ['18.4', '17.10'];

  console.log(`[download-pg] 准备安装 PG 版本: ${versions.join(', ')}`);
  console.log(`[download-pg] 安装目录: ${PG_DIR}`);

  for (const version of versions) {
    try {
      await installVersion(version);
    } catch (err) {
      console.error(`[download-pg] 安装 PG ${version} 失败:`, err);
      process.exitCode = 1;
    }
  }

  console.log('[download-pg] 完成');
}

await main();
