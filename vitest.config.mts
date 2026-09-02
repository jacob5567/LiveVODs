import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**'],
    // Node by default; component tests opt into a DOM with a per-file
    // `@vitest-environment happy-dom` docblock.
    environment: 'node',
    environmentOptions: {
      happyDOM: {
        settings: {
          // The player pane renders real Twitch and YouTube iframes. Left
          // enabled, happy-dom actually fetches them — turning unit tests into
          // network calls that are slow offline and flaky everywhere.
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
        },
      },
    },
    // Note: with loading disabled, happy-dom throws a NotSupportedError per
    // mounted iframe and React's dev logger prints the stack. It is only noise
    // above a passing summary — neither onConsoleLog nor onUnhandledError
    // intercepts it, since it is emitted outside vitest's capture.
  },
});
