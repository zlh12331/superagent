// src/main/infra/storage/app-data.ts
// 用户数据目录路径管理
// 设计文档 §4.3 storage/app-data 职责
//
// 封装 app.getPath('userData')，提供各子目录路径
// dev 环境 userData 重定向到 .electron-user-data/（在 index.ts 中设置）

import { join } from 'node:path';
import { app } from 'electron';

/**
 * 获取 userData 基路径
 *
 * 设计文档 §1.2：数据目录放 %APPDATA%/<AppName>/
 * dev 环境由 index.ts 重定向到 .electron-user-data/
 */
export function getUserDataPath(): string {
  return app.getPath('userData');
}

/**
 * 获取日志目录路径
 *
 * electron-log 文件日志输出到此目录
 */
export function getLogsPath(): string {
  return join(getUserDataPath(), 'logs');
}

/**
 * 获取数据库备份目录路径
 *
 * 设计文档 §2.6：每日备份到 %APPDATA%/App/backups/
 */
export function getBackupsPath(): string {
  return join(getUserDataPath(), 'backups');
}

/**
 * 获取缓存目录路径
 *
 * 用于临时文件、下载缓存等
 */
export function getCachePath(): string {
  return join(getUserDataPath(), 'cache');
}

/**
 * 获取 keychain（加密存储）文件路径
 *
 * safeStorage 加密后的数据存储到此文件
 * 设计文档 §1.2 决策 5：API Key 存钥匙串
 */
export function getKeychainPath(): string {
  return join(getUserDataPath(), 'keychain.dat');
}
