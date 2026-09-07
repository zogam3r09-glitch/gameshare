import type { GameShareApi } from '../../preload/index.js';

declare global {
  interface Window {
    /** Unica superficie exposta pelo preload. Nada de Node aqui. */
    readonly gameShare: GameShareApi;
  }
}

export {};
