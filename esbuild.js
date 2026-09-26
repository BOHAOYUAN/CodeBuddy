const esbuild = require('esbuild');

async function build() {
  try {
    await esbuild.build({
      entryPoints: ['src/extension.ts'],
      bundle: true,
      outfile: 'dist/extension.js',
      external: ['vscode'],
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      sourcemap: true,
      logLevel: 'info',
    });
    console.log('Build complete: dist/extension.js');
  } catch (e) {
    console.error('Build failed:', e);
    process.exit(1);
  }
}

build();
