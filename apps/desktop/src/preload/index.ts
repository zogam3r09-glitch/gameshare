import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureSource } from '@game-share/shared';

/**
 * Ponte minima. Nenhuma API de Node e exposta ao renderer: apenas estas
 * funcoes, todas com o argumento validado do outro lado (main).
 */
const api = {
  /**
   * Avisa o main que ha transmissao no ar, para ele pedir confirmacao antes de
   * fechar a janela. Sem isto um clique errado no X derruba a transmissao e
   * mata o link que os amigos ja estao assistindo, sem nenhum aviso.
   */
  setBroadcasting: (live: boolean): Promise<void> =>
    ipcRenderer.invoke('app:setBroadcasting', live),
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
