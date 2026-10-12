// app-data.ts：userData 下的标准路径表——所有落盘位置从这里取，不散写 app.getPath
import { join } from 'node:path';
import { app } from 'electron';

/** userData 根（dev 重定向 .electron-user-data，prod 为系统目录） */
export function getUserDataPath(): string {
  return app.getPath('userData');
}

/** 主进程日志目录（electron-log main.log 所在） */
export function getLogsPath(): string {
  return join(getUserDataPath(), 'logs');
}

/** 数据库备份目录 */
export function getBackupsPath(): string {
  return join(getUserDataPath(), 'backups');
}

/** 通用缓存目录 */
export function getCachePath(): string {
  return join(getUserDataPath(), 'cache');
}

/** 密钥库文件（keychain.dat，safeStorage 加密字节） */
export function getKeychainPath(): string {
  return join(getUserDataPath(), 'keychain.dat');
}
