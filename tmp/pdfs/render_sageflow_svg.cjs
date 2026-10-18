const fs = require('fs');
const path = require('path');
const sharp = require('C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');

const sourceDir = 'D:/SageFlow用户智能层/projects/sageflow_guochuang_v1_ppt169_20260907/svg_final';
const outputDir = 'D:/SageFlow用户智能层/tmp/pdfs/sageflow_pages';
fs.mkdirSync(outputDir, { recursive: true });

async function main() {
  const files = fs.readdirSync(sourceDir).filter((name) => name.endsWith('.svg')).sort();
  for (const file of files) {
    const input = path.join(sourceDir, file);
    const output = path.join(outputDir, file.replace(/\.svg$/i, '.png'));
    await sharp(input, { density: 144 }).resize(1280, 720).png().toFile(output);
    process.stdout.write(`Rendered ${file}\n`);
  }
  process.stdout.write(`Rendered ${files.length} pages\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
