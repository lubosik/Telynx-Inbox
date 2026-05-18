const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.fillStyle = '#16a34a';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // White "V"
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.floor(size * 0.55)}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('V', size / 2, size / 2 + size * 0.03);

  return canvas.toBuffer('image/png');
}

const iconsDir = path.join(__dirname, 'public', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), generateIcon(192));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), generateIcon(512));
console.log('Icons generated: icon-192.png, icon-512.png');
