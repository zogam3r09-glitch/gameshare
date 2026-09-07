import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureSource } from '@game-share/shared';

/**
 * Ponte minima. Nenhuma API de Node e exposta ao renderer: apenas estas cinco
 * funcoes, todas com o argumento validado do outro lado (main).
 */
const api = {
  listCaptureSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:list'),
  selectCaptureSource: (sourceId: string): Promise<boolean> =>
    ipcRenderer.invoke('capture:select', sourceId),
  clearCaptureSource: (): Promise<void> => ipcRenderer.invoke('capture:clear'),
  reportAudioUnavailable: (): Promise<void> => ipcRenderer.invoke('capture:audioUnavailable'),
  isLoopbackAudioSupported: (): Promise<boolean> => ipcRenderer.invoke('capture:loopbackSupported'),
  copyToClipboard: (text: string): Promise<boolean> => ipcRenderer.invoke('shell:copy', text),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),
} as const;

export type GameShareApi = typeof api;

contextBridge.exposeInMainWorld('gameShare', api);
