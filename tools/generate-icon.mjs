import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

async function main() {
  try {
    const root = process.cwd();
    // Use a dedicated colored SVG for the marketplace PNG so the activity-bar SVG can remain monochrome.
    const svgPath = resolve(root, 'media', 'workflow-icon-color.svg');
    const pngPath = resolve(root, 'media', 'icon.png');

    const svg = await readFile(svgPath, 'utf8');

    // Render the SVG to a 128x128 PNG with transparent background
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 128 },
      background: 'transparent',
    });

    const render = resvg.render();
    const pngData = render.asPng();

    await mkdir(dirname(pngPath), { recursive: true });
    await writeFile(pngPath, pngData);

    console.log(`Generated ${pngPath}`);
  } catch (err) {
    console.error('Failed to generate icon.png from workflow-icon.svg:', err);
    process.exitCode = 1;
  }
}

main();
