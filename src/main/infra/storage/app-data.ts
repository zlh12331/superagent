import { join } from 'node:path';
import { app } from 'electron';

export function getUserDataPath(): string {
  return app.getPath('userData');
}

export function getLogsPath(): string {
  return join(getUserDataPath(), 'logs');
}

export function getBackupsPath(): string {
  return join(getUserDataPath(), 'backups');
}

export function getCachePath(): string {
  return join(getUserDataPath(), 'cache');
}

export function getKeychainPath(): string {
  return join(getUserDataPath(), 'keychain.dat');
}
