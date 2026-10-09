import {build} from 'esbuild';
import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
mkdirSync('dist/apps/desktop/renderer',{recursive:true});
await build({entryPoints:['apps/desktop/renderer/src/main.tsx'],bundle:true,platform:'browser',format:'esm',target:'chrome144',outfile:'dist/apps/desktop/renderer/app.js',minify:true,sourcemap:true,define:{'process.env.NODE_ENV':'"production"'}});
await build({entryPoints:['apps/desktop/preload.ts'],bundle:true,platform:'node',format:'cjs',target:'node24',outfile:'dist/apps/desktop/preload.cjs',external:['electron']});
copyFileSync('apps/desktop/renderer/public/umi-logo.png','dist/apps/desktop/renderer/umi-logo.png');
copyFileSync('apps/desktop/renderer/public/umi-lockup.png','dist/apps/desktop/renderer/umi-lockup.png');
writeFileSync('dist/apps/desktop/renderer/index.html','<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-src \'none\'"><title>Umi</title><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>');
