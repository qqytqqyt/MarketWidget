// Generates build/icon.png (256px) and build/icon.ico (multi-size, PNG-encoded
// entries) by rendering build/icon.html in a hidden window.
// Run with: npx electron build/gen-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 128, 64, 48, 32, 16];

function buildIco(pngs) {
  // ICO container with PNG-compressed images (valid since Windows Vista)
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + 16 * count;
  pngs.forEach(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 300, show: false });
  await win.loadFile(path.join(__dirname, 'icon.html'));

  const pngs = [];
  for (const size of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`renderIcon(${size})`);
    pngs.push({ size, buf: Buffer.from(dataUrl.split(',')[1], 'base64') });
  }

  fs.writeFileSync(path.join(__dirname, 'icon.png'), pngs[0].buf);
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(pngs));
  console.log('wrote build/icon.png and build/icon.ico');
  app.quit();
});
