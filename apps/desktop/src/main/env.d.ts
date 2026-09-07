interface ImportMetaEnv {
  /** URL publica do token-server. Nunca coloque segredos em vars VITE_*. */
  readonly VITE_TOKEN_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
