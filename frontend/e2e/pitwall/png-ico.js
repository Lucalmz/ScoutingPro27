import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function isJpegBuffer(buf) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function parsePng(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error('parsePng expects a Buffer');
  }
  if (isJpegBuffer(buf)) {
    throw new Error('Input is JPEG (FF D8 FF), not PNG');
  }
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('Invalid PNG signature');
  }

  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  let sawIend = false;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk ${type}`);
    }
    const chunkData = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      if (chunkData.length < 13) throw new Error('Invalid IHDR chunk length');
      ihdr = {
        width: chunkData.readUInt32BE(0),
        height: chunkData.readUInt32BE(4),
        bitDepth: chunkData[8],
        colorType: chunkData[9],
        compression: chunkData[10],
        filter: chunkData[11],
        interlace: chunkData[12]
      };
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }

    offset = dataEnd + 4;
  }

  if (!ihdr) throw new Error('PNG missing IHDR chunk');
  if (!sawIend) throw new Error('PNG missing IEND chunk');
  if (ihdr.width === 0 || ihdr.height === 0) {
    throw new Error(`Invalid PNG dimensions: ${ihdr.width}x${ihdr.height}`);
  }
  if (ihdr.bitDepth !== 8) throw new Error(`Unsupported PNG bitDepth=${ihdr.bitDepth} (expected 8)`);
  if (ihdr.interlace !== 0) throw new Error(`Unsupported PNG interlace=${ihdr.interlace} (expected 0)`);

  const bytesPerPixel =
    ihdr.colorType === 6 ? 4 :
    ihdr.colorType === 2 ? 3 :
    ihdr.colorType === 4 ? 2 :
    ihdr.colorType === 0 ? 1 : 0;

  if (bytesPerPixel === 0) {
    throw new Error(`Unsupported PNG colorType=${ihdr.colorType}`);
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = ihdr.width * bytesPerPixel;
  const expectedLen = (stride + 1) * ihdr.height;
  if (inflated.length < expectedLen) {
    throw new Error(`Inflated IDAT length ${inflated.length} < expected ${expectedLen}`);
  }

  const raw = new Uint8Array(ihdr.width * ihdr.height * bytesPerPixel);
  const rgba = new Uint8Array(ihdr.width * ihdr.height * 4);

  for (let y = 0; y < ihdr.height; y += 1) {
    const rowIn = y * (stride + 1);
    const filterType = inflated[rowIn];
    const rowOut = y * stride;
    const prevRowOut = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const filt = inflated[rowIn + 1 + x];
      const left = x >= bytesPerPixel ? raw[rowOut + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[prevRowOut + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? raw[prevRowOut + x - bytesPerPixel] : 0;

      let val;
      if (filterType === 0) val = filt;
      else if (filterType === 1) val = (filt + left) & 0xff;
      else if (filterType === 2) val = (filt + up) & 0xff;
      else if (filterType === 3) val = (filt + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) val = (filt + paethPredictor(left, up, upLeft)) & 0xff;
      else throw new Error(`Unknown PNG scanline filter type ${filterType} at row ${y}`);

      raw[rowOut + x] = val;
    }

    for (let px = 0; px < ihdr.width; px += 1) {
      const src = rowOut + px * bytesPerPixel;
      const dst = (y * ihdr.width + px) * 4;
      if (ihdr.colorType === 6) {
        rgba[dst] = raw[src];
        rgba[dst + 1] = raw[src + 1];
        rgba[dst + 2] = raw[src + 2];
        rgba[dst + 3] = raw[src + 3];
      } else if (ihdr.colorType === 2) {
        rgba[dst] = raw[src];
        rgba[dst + 1] = raw[src + 1];
        rgba[dst + 2] = raw[src + 2];
        rgba[dst + 3] = 255;
      } else if (ihdr.colorType === 4) {
        rgba[dst] = raw[src];
        rgba[dst + 1] = raw[src];
        rgba[dst + 2] = raw[src];
        rgba[dst + 3] = raw[src + 1];
      } else {
        rgba[dst] = raw[src];
        rgba[dst + 1] = raw[src];
        rgba[dst + 2] = raw[src];
        rgba[dst + 3] = 255;
      }
    }
  }

  function getPixel(x, y) {
    if (x < 0 || x >= ihdr.width || y < 0 || y >= ihdr.height) {
      throw new RangeError(`Pixel (${x}, ${y}) out of bounds (${ihdr.width}x${ihdr.height})`);
    }
    const idx = (y * ihdr.width + x) * 4;
    return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]];
  }

  function sampleStats() {
    let transparentCount = 0;
    let semiTransparentCount = 0;
    let opaqueCount = 0;
    let opaqueBlackCount = 0;
    let pitGreenCount = 0;
    let maxAlpha = 0;

    const total = ihdr.width * ihdr.height;
    for (let i = 0; i < total; i += 1) {
      const idx = i * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const a = rgba[idx + 3];
      if (a > maxAlpha) maxAlpha = a;
      if (a === 0) transparentCount += 1;
      else if (a < 255) semiTransparentCount += 1;
      else opaqueCount += 1;

      if (a > 240 && r < 8 && g < 8 && b < 8) opaqueBlackCount += 1;
      if (a > 128 && g > 180 && r < 140 && b < 100) pitGreenCount += 1;
    }

    return {
      total,
      transparentCount,
      semiTransparentCount,
      opaqueCount,
      opaqueBlackCount,
      pitGreenCount,
      maxAlpha
    };
  }

  function inspectBorder(marginPx = 4) {
    const w = ihdr.width;
    const h = ihdr.height;
    const m = Math.max(1, Math.min(marginPx, Math.floor(Math.min(w, h) / 4)));
    let borderPixels = 0;
    let transparentBorder = 0;
    let opaqueBlackBorder = 0;

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x >= m && x < w - m && y >= m && y < h - m) continue;
        borderPixels += 1;
        const [r, g, b, a] = getPixel(x, y);
        if (a <= 12) transparentBorder += 1;
        if (a > 240 && r < 8 && g < 8 && b < 8) opaqueBlackBorder += 1;
      }
    }

    const corners = [
      getPixel(0, 0),
      getPixel(w - 1, 0),
      getPixel(0, h - 1),
      getPixel(w - 1, h - 1)
    ];

    return {
      corners,
      allCornersTransparent: corners.every(([, , , a]) => a === 0),
      borderPixels,
      transparentRatio: borderPixels ? transparentBorder / borderPixels : 0,
      opaqueBlackRatio: borderPixels ? opaqueBlackBorder / borderPixels : 0
    };
  }

  return {
    ...ihdr,
    rgba,
    getPixel,
    sampleStats,
    inspectBorder
  };
}

export function readPngFile(filePath) {
  return parsePng(fs.readFileSync(filePath));
}

export function parseIco(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6) {
    throw new Error('ICO buffer too short');
  }
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);

  if (reserved !== 0 || type !== 1 || count < 1) {
    throw new Error(`Invalid ICO header: reserved=${reserved}, type=${type}, count=${count}`);
  }
  const headerSize = 6 + count * 16;
  if (buf.length < headerSize) {
    throw new Error(`Truncated ICO directory table (len=${buf.length}, need>=${headerSize})`);
  }

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    const width = buf[off] === 0 ? 256 : buf[off];
    const height = buf[off + 1] === 0 ? 256 : buf[off + 1];
    const colorCount = buf[off + 2];
    const planes = buf.readUInt16LE(off + 4);
    const bpp = buf.readUInt16LE(off + 6);
    const bytesInRes = buf.readUInt32LE(off + 8);
    const imageOffset = buf.readUInt32LE(off + 12);

    if (imageOffset + bytesInRes > buf.length) {
      throw new Error(`ICO entry ${i} (${width}x${height}) exceeds file length`);
    }

    const payload = buf.subarray(imageOffset, imageOffset + bytesInRes);
    const isPng = payload.length >= 8 && payload.subarray(0, 8).equals(PNG_MAGIC);
    const isDib = !isPng && payload.length >= 40 && payload.readUInt32LE(0) === 40;
    if (!isPng && !isDib) {
      throw new Error(`ICO entry ${i} (${width}x${height}) has invalid payload (neither PNG nor DIB)`);
    }
    let parsedPng = null;
    if (isPng) {
      parsedPng = parsePng(payload);
    }

    entries.push({
      index: i,
      width,
      height,
      colorCount,
      planes,
      bpp,
      bytesInRes,
      imageOffset,
      isPng,
      isDib,
      pngWidth: parsedPng?.width ?? null,
      pngHeight: parsedPng?.height ?? null,
      pngColorType: parsedPng?.colorType ?? null
    });
  }

  return { reserved, type, count, entries };
}

export function buildSyntheticRgbaPng(width, height, pixelFn) {
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bitDepth
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const pxStart = rowStart + 1 + x * 4;
      raw[pxStart] = r & 0xff;
      raw[pxStart + 1] = g & 0xff;
      raw[pxStart + 2] = b & 0xff;
      raw[pxStart + 3] = a & 0xff;
    }
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_MAGIC,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

export function buildSyntheticIco(sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
  const payloads = sizes.map((sz) => {
    const png = buildSyntheticRgbaPng(sz, sz, (x, y) =>
      x === 0 || y === 0 ? [0, 0, 0, 0] : [0x39, 0xff, 0x14, 0xff]
    );
    return { sz, png };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(payloads.length, 4);

  const dirEntries = [];
  let offset = 6 + payloads.length * 16;
  for (const item of payloads) {
    const entry = Buffer.alloc(16);
    entry[0] = item.sz >= 256 ? 0 : item.sz;
    entry[1] = item.sz >= 256 ? 0 : item.sz;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += item.png.length;
    dirEntries.push(entry);
  }

  return Buffer.concat([header, ...dirEntries, ...payloads.map((p) => p.png)]);
}

function blitAlphaScaled(dstRgba, dstW, dstH, srcPng, dx, dy, targetW, targetH) {
  for (let y = 0; y < targetH; y += 1) {
    const outY = dy + y;
    if (outY < 0 || outY >= dstH) continue;
    const sy = Math.min(srcPng.height - 1, Math.floor((y * srcPng.height) / targetH));
    for (let x = 0; x < targetW; x += 1) {
      const outX = dx + x;
      if (outX < 0 || outX >= dstW) continue;
      const sx = Math.min(srcPng.width - 1, Math.floor((x * srcPng.width) / targetW));
      const [sr, sg, sb, sa] = srcPng.getPixel(sx, sy);
      if (sa === 0) continue;
      const idx = (outY * dstW + outX) * 4;
      const alpha = sa / 255;
      const inv = 1 - alpha;
      dstRgba[idx] = Math.round(sr * alpha + dstRgba[idx] * inv);
      dstRgba[idx + 1] = Math.round(sg * alpha + dstRgba[idx + 1] * inv);
      dstRgba[idx + 2] = Math.round(sb * alpha + dstRgba[idx + 2] * inv);
      dstRgba[idx + 3] = 255;
    }
  }
}

export function generateMultiScaleBrandPreview(outPath, {
  logo512Path,
  logo128Path,
  logo32Path,
  logo24Path,
  logoBearPath
}) {
  const width = 920;
  const height = 600;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 0x0b;
    rgba[i * 4 + 1] = 0x0e;
    rgba[i * 4 + 2] = 0x10;
    rgba[i * 4 + 3] = 0xff;
  }

  // Subtle 1px Pit Wall frame (#1B2126)
  for (let x = 0; x < width; x += 1) {
    for (const y of [0, height - 1]) {
      const idx = (y * width + x) * 4;
      rgba[idx] = 0x1b;
      rgba[idx + 1] = 0x21;
      rgba[idx + 2] = 0x26;
    }
  }

  if (logo512Path && fs.existsSync(logo512Path)) {
    const p512 = readPngFile(logo512Path);
    blitAlphaScaled(rgba, width, height, p512, 32, 44, 512, 512);
  }
  if (logo128Path && fs.existsSync(logo128Path)) {
    const p128 = readPngFile(logo128Path);
    blitAlphaScaled(rgba, width, height, p128, 576, 44, 128, 128);
  }
  if (logo32Path && fs.existsSync(logo32Path)) {
    const p32 = readPngFile(logo32Path);
    blitAlphaScaled(rgba, width, height, p32, 728, 44, 32, 32);
  }
  if (logo24Path && fs.existsSync(logo24Path)) {
    const p24 = readPngFile(logo24Path);
    blitAlphaScaled(rgba, width, height, p24, 780, 44, 24, 24);
  }
  if (logoBearPath && fs.existsSync(logoBearPath) && !isJpegBuffer(fs.readFileSync(logoBearPath))) {
    const bear = readPngFile(logoBearPath);
    const targetH = 180;
    const targetW = Math.max(1, Math.round((bear.width / bear.height) * targetH));
    blitAlphaScaled(rgba, width, height, bear, 576, 220, targetW, targetH);
  }

  const outPng = buildSyntheticRgbaPng(width, height, (x, y) => {
    const idx = (y * width + x) * 4;
    return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]];
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outPng);
  return outPath;
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}
