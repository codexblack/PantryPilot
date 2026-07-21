import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const sourcePath = fileURLToPath(new URL('../assets/pantry-pilot-source.svg', import.meta.url));
const assetsPath = new URL('../assets/', import.meta.url);
const rawSource = await readFile(sourcePath, 'utf8');
const sourceMark = rawSource.match(/<g\b[\s\S]*<\/g>/)?.[0];

if (!sourceMark) throw new Error('Could not find the PantryPilot mark in the supplied SVG.');

const makeSvg = (withBackground, markColor = '#2F5B48') => {
  const mark = sourceMark.replace(/fill="#[0-9a-fA-F]{6}"/, `fill="${markColor}"`);
  const sourceLayer = `<g transform="translate(152 157) scale(1.2)">${mark}</g>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  ${withBackground ? '<rect width="1024" height="1024" fill="#F7F7F1"/>' : ''}
  <defs><clipPath id="pantry-pilot-dish"><circle cx="512" cy="568" r="204"/></clipPath></defs>
  <g transform="translate(512 512) scale(1.76) translate(-512 -568)">
    <g clip-path="url(#pantry-pilot-dish)">${sourceLayer}</g>
  </g>
</svg>`;
};

async function render(svg, filename, width) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'transparent' })
    .render()
    .asPng();
  await writeFile(fileURLToPath(new URL(filename, assetsPath)), png);
}

const iconSvg = makeSvg(true);
const foregroundSvg = makeSvg(false);
const splashSvg = makeSvg(false, '#F2F8F1');
await writeFile(fileURLToPath(new URL('pantry-pilot-themed.svg', assetsPath)), iconSvg);
await render(iconSvg, 'icon.png', 1024);
await render(foregroundSvg, 'adaptive-icon.png', 1024);
await render(splashSvg, 'splash.png', 512);
await render(iconSvg, 'favicon.png', 64);
console.log('Generated PantryPilot icon, adaptive icon, splash, and favicon assets.');
