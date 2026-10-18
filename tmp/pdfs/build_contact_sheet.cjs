const fs = require('fs');
const path = require('path');
const sharp = require('C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');

const inputDir = 'D:/SageFlow用户智能层/tmp/pdfs/qa';
const output = 'D:/SageFlow用户智能层/tmp/pdfs/SageFlow_16页总览.png';
const files = fs.readdirSync(inputDir).filter((name) => /^page-\d+\.png$/.test(name)).sort();
const thumbW = 384;
const thumbH = 216;
const gap = 18;
const labelH = 30;
const cols = 4;
const rows = 4;
const width = cols * thumbW + (cols + 1) * gap;
const height = rows * (thumbH + labelH) + (rows + 1) * gap;

async function main() {
  const composites = [];
  for (let i = 0; i < files.length; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = gap + col * (thumbW + gap);
    const top = gap + row * (thumbH + labelH + gap);
    const buffer = await sharp(path.join(inputDir, files[i])).resize(thumbW, thumbH).png().toBuffer();
    composites.push({ input: buffer, left, top });
    const label = Buffer.from(`<svg width="${thumbW}" height="${labelH}"><rect width="100%" height="100%" fill="#17324D"/><text x="14" y="21" font-family="Arial" font-size="15" font-weight="700" fill="#F7F4EC">PAGE ${String(i + 1).padStart(2, '0')}</text></svg>`);
    composites.push({ input: label, left, top: top + thumbH });
  }
  await sharp({ create: { width, height, channels: 4, background: '#DCE3E4' } }).composite(composites).png().toFile(output);
  process.stdout.write(`Created ${output}\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
