let closeConfirmed = false;

export function isCloseConfirmed(): boolean {
  return closeConfirmed;
}

export function setCloseConfirmed(): void {
  closeConfirmed = true;
}

let quitting = false;

export function isQuitting(): boolean {
  return quitting;
}

export function setQuitting(): void {
  quitting = true;
}

let deferredInstallPending = false;

export function requestDeferredInstall(): void {
  deferredInstallPending = true;
}

export function isDeferredInstallPending(): boolean {
  return deferredInstallPending;
}

export function clearDeferredInstall(): void {
  deferredInstallPending = false;
}
