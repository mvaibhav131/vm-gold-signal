/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` (default until phase U5) or `live`. */
  readonly VITE_DATA_SOURCE?: 'mock' | 'live';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
