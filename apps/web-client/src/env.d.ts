/**
 * Ambient declarations for non-TypeScript imports.
 *
 * The app compiles with `types: []` so no stray global type packages leak in; the handful of Vite
 * asset imports it actually uses are declared explicitly here instead.
 */

declare module '*.css' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
