// QR Model 2, byte mode, error correction L; versions 3–5 each use one block.
const VERSIONS = [
  { size: 29, data: 55, ecc: 15 },
  { size: 33, data: 80, ecc: 20 },
  { size: 37, data: 108, ecc: 26 },
];

function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function parity(data, degree) {
  let generator = [1], root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= multiply(generator[j], root);
    }
    generator = next;
    root = multiply(root, 2);
  }
  const result = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = result[i];
    for (let j = 0; j < generator.length; j++) result[i + j] ^= multiply(generator[j], factor);
  }
  return result.slice(data.length);
}

function codewords(bytes, spec) {
  const bits = [];
  const add = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  add(4, 4);
  add(bytes.length, 8);
  for (const byte of bytes) add(byte, 8);
  const capacity = spec.data * 8;
  for (let i = 0, n = Math.min(4, capacity - bits.length); i < n; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  while (data.length < spec.data) data.push((data.length - Math.ceil(bits.length / 8)) % 2 ? 0x11 : 0xec);
  return [...data, ...parity(data, spec.ecc)];
}

function functions(size) {
  const m = Array.from({ length: size }, () => Array(size).fill(null));
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size) m[y][x] = v; };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const d = Math.max(Math.abs(x), Math.abs(y));
      set(cx + x, cy + y, d !== 2 && d !== 4 ? 1 : 0);
    }
  }
  for (let i = 8; i < size - 8; i++) { set(i, 6, 1 - i % 2); set(6, i, 1 - i % 2); }
  const center = size - 7;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(center + x, center + y, Math.max(Math.abs(x), Math.abs(y)) === 1 ? 0 : 1);
  for (let i = 0; i < 9; i++) {
    if (m[i][8] === null) set(8, i, 0);
    if (m[8][i] === null) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, 0); set(8, size - 1 - i, 0); }
  set(8, size - 8, 1);
  return m;
}

function format(m, mask) {
  const size = m.length, value = (1 << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((value << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = 1;
}

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const spec = VERSIONS.find((v) => bytes.length <= v.data - 2);
  if (!spec) throw new RangeError('QR URL is too long');
  const m = functions(spec.size), words = codewords(bytes, spec);
  let bit = 0;
  for (let right = spec.size - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let v = 0; v < spec.size; v++) {
      const y = ((right + 1) & 2) === 0 ? spec.size - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (m[y][x] !== null) continue;
        const value = bit < words.length * 8 ? (words[bit >>> 3] >>> (7 - (bit & 7))) & 1 : 0;
        m[y][x] = value ^ ((x + y) % 2 === 0 ? 1 : 0);
        bit++;
      }
    }
  }
  format(m, 0);
  return m;
}

export const QR_SIZE = 29;
