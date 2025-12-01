/**
 * Rollup configuration for Svelte webview components
 * Updated for Svelte 5 compatibility
 */
import svelte from 'rollup-plugin-svelte';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import sveltePreprocess from 'svelte-preprocess';

const production = !process.env.ROLLUP_WATCH;

/**
 * Create config for a webview component
 */
function createConfig(input, output) {
  return {
    input,
    output: {
      sourcemap: !production,
      format: 'iife',
      name: 'SvelteApp',
      file: output,
    },
    plugins: [
      svelte({
        preprocess: sveltePreprocess({
          sourceMap: !production,
          typescript: {
            tsconfigFile: './webview/tsconfig.json',
          },
        }),
        compilerOptions: {
          dev: !production,
          // Svelte 5: Use compatibility mode (runes: false) for legacy syntax
          runes: false,
        },
        emitCss: false, // Inline CSS instead of emitting separate files
      }),
      resolve({
        browser: true,
        dedupe: ['svelte'],
        exportConditions: ['svelte', 'browser'],
      }),
      commonjs(),
      typescript({
        tsconfig: './webview/tsconfig.json',
        sourceMap: !production,
        inlineSources: !production,
      }),
      production &&
        terser({
          compress: {
            drop_console: false, // Keep console.log statements for debugging
          },
        }),
    ],
    watch: {
      clearScreen: false,
    },
  };
}

export default [
  createConfig('webview/sidebar-wrapper.js', 'dist/sidebar.js'),
  createConfig('webview/workflow-runs-wrapper.js', 'dist/workflow-runs.js'),
];
