const textEncoder = new TextEncoder();

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = Math.floor(date.getSeconds() / 2);

  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosDate, dosTime };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return textEncoder.encode(data);
  return textEncoder.encode(String(data));
}

export function createZip(files) {
  const entries = [];
  let localDirSize = 0;
  let centralDirSize = 0;
  const now = new Date();
  const { dosDate, dosTime } = dosDateTime(now);

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const dataBytes = asBytes(file.data);
    const crc = crc32(dataBytes);
    const localHeaderSize = 30 + nameBytes.length;
    const centralHeaderSize = 46 + nameBytes.length;

    entries.push({
      nameBytes,
      dataBytes,
      crc,
      localHeaderSize,
      centralHeaderSize,
      localHeaderOffset: localDirSize
    });
    localDirSize += localHeaderSize + dataBytes.length;
    centralDirSize += centralHeaderSize;
  }

  const out = new Uint8Array(localDirSize + centralDirSize + 22);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const entry of entries) {
    writeU32(view, offset, 0x04034b50);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 0);
    writeU16(view, offset + 8, 0);
    writeU16(view, offset + 10, dosTime);
    writeU16(view, offset + 12, dosDate);
    writeU32(view, offset + 14, entry.crc);
    writeU32(view, offset + 18, entry.dataBytes.length);
    writeU32(view, offset + 22, entry.dataBytes.length);
    writeU16(view, offset + 26, entry.nameBytes.length);
    writeU16(view, offset + 28, 0);
    out.set(entry.nameBytes, offset + 30);
    offset += entry.localHeaderSize;
    out.set(entry.dataBytes, offset);
    offset += entry.dataBytes.length;
  }

  const centralDirOffset = offset;
  for (const entry of entries) {
    writeU32(view, offset, 0x02014b50);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 20);
    writeU16(view, offset + 8, 0);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, dosTime);
    writeU16(view, offset + 14, dosDate);
    writeU32(view, offset + 16, entry.crc);
    writeU32(view, offset + 20, entry.dataBytes.length);
    writeU32(view, offset + 24, entry.dataBytes.length);
    writeU16(view, offset + 28, entry.nameBytes.length);
    writeU16(view, offset + 30, 0);
    writeU16(view, offset + 32, 0);
    writeU16(view, offset + 34, 0);
    writeU16(view, offset + 36, 0);
    writeU32(view, offset + 38, 0);
    writeU32(view, offset + 42, entry.localHeaderOffset);
    out.set(entry.nameBytes, offset + 46);
    offset += entry.centralHeaderSize;
  }

  writeU32(view, offset, 0x06054b50);
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, files.length);
  writeU16(view, offset + 10, files.length);
  writeU32(view, offset + 12, centralDirSize);
  writeU32(view, offset + 16, centralDirOffset);
  writeU16(view, offset + 20, 0);

  return out;
}
