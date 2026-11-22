// Dependency-free QR encoder for short byte-mode URLs (QR Model 2, version 3-L).
const SIZE = 29;
const DATA_CODEWORDS = 53;
const ECC_CODEWORDS = 17;

const gfMul = (a, b) => {
  let out = 0;
  for (let i = 7; i >= 0; i--) {
    out = (out << 1) ^ ((out >>> 7) * 0x11d);
    if (b & (1 << i)) out ^= a;
  }
  return out & 0xff;
};

function reedSolomon(data) {
  const divisor = [1];
  let root = 1;
  for (let i = 0; i < ECC_CODEWORDS; i++) {
    const next = new Array(divisor.length + 1).fill(0);
    for (let j = 0; j < divisor.length; j++) {
      next[j] ^= divisor[j];
      next[j + 1] ^= gfMul(divisor[j], root);
    }
    divisor.length = 0;
    divisor.push(...next);
    root = gfMul(root, 2);
  }
  const result = [...data, ...new Array(ECC_CODEWORDS).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = result[i];
    if (!factor) continue;
    for (let j = 0; j < divisor.length; j++) result[i + j] ^= gfMul(divisor[j], factor);
  }
  return result.slice(data.length);
}

function formatBits(mask) {
  const data = (1 << 3) | mask; // EC level L
  let bits = data << 10;
  let rem = bits;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  bits = ((data << 10) | rem) ^ 0x5412;
  const out = [];
  for (let i = 14; i >= 0; i--) out.push((bits >>> i) & 1);
  return out;
}

function setFinder(m, x, y) {
  for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
    const v = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
      (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
    m[yy][xx] = v ? 1 : 0;
  }
}

function setAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    m[cy + dy][cx + dx] = (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) ? 1 : 0;
  }
}

function makeMatrix() {
  const m = Array.from({ length: SIZE }, () => new Array(SIZE).fill(-1));
  setFinder(m, 3, 3);
  setFinder(m, SIZE - 4, 3);
  setFinder(m, 3, SIZE - 4);
  setAlignment(m, 6, 22);
  setAlignment(m, 22, 6);
  setAlignment(m, 22, 22);
  for (let i = 0; i < SIZE; i++) {
    if (m[i][6] < 0) m[i][6] = i % 2 === 0 ? 1 : 0;
    if (m[6][i] < 0) m[6][i] = i % 2 === 0 ? 1 : 0;
  }
  for (let i = 0; i < 9; i++) {
    if (m[i][8] < 0) m[i][8] = 0;
    if (m[8][i] < 0) m[8][i] = 0;
  }
  for (let i = SIZE - 8; i < SIZE; i++) {
    if (m[i][8] < 0) m[i][8] = 0;
    if (m[8][i] < 0) m[8][i] = 0;
  }
  return m;
}

function dataCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 53) throw new RangeError('QR text is too long');
  const bits = [];
  const add = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  add(0b0100, 4);
  add(bytes.length, 8);
  bytes.forEach((b) => add(b, 8));
  while (bits.length < DATA_CODEWORDS * 8 && bits.length % 8) bits.push(0);
  for (const pad of [0xec, 0x11]) {
    while (bits.length < DATA_CODEWORDS * 8) add(pad, 8);
  }
  const out = [];
  for (let i = 0; i < DATA_CODEWORDS; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    out.push(b);
  }
  return out;
}

function placeData(m, codewords) {
  const bits = [];
  codewords.forEach((b) => { for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1); });
  let bit = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vert = 0; vert < SIZE; vert++) {
      for (let col = 0; col < 2; col++) {
        const x = right - col, upward = ((right + 1) & 2) === 0;
        const y = upward ? SIZE - 1 - vert : vert;
        if (m[y][x] < 0) m[y][x] = bit < bits.length ? bits[bit++] : 0;
      }
    }
  }
  return bit;
}

function drawFormat(m, mask) {
  const b = formatBits(mask);
  for (let i = 0; i < 6; i++) m[i][8] = b[i];
  m[7][8] = b[6]; m[8][8] = b[7]; m[8][7] = b[8];
  for (let i = 0; i < 6; i++) m[8][5 - i] = b[14 - i];
  m[8][7] = b[8];
  for (let i = 0; i < 8; i++) {
    m[SIZE - 1 - i][8] = b[i];
    m[8][SIZE - 1 - i] = b[i + 8];
  }
}

function maskPenalty(m) {
  let penalty = 0;
  for (let y = 0; y < SIZE; y++) {
    let run = 1;
    for (let x = 1; x < SIZE; x++) {
      if (m[y][x] === m[y][x - 1]) { if (++run === 5) penalty += 3; else if (run > 5) penalty++; }
      else run = 1;
    }
  }
  for (let x = 0; x < SIZE; x++) {
    let run = 1;
    for (let y = 1; y < SIZE; y++) {
      if (m[y][x] === m[y - 1][x]) { if (++run === 5) penalty += 3; else if (run > 5) penalty++; }
      else run = 1;
    }
  }
  for (let y = 0; y < SIZE - 1; y++) for (let x = 0; x < SIZE - 1; x++) {
    const v = m[y][x];
    if (v >= 0 && v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) penalty += 3;
  }
  return penalty;
}

function maskedCopy(base, mask) {
  const m = base.map((row) => row.slice());
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (base[y][x] >= 0) continue;
    m[y][x] = 0;
    let flip = false;
    if (mask === 0) flip = (x + y) % 2 === 0;
    else if (mask === 1) flip = y % 2 === 0;
    else if (mask === 2) flip = x % 3 === 0;
    else if (mask === 3) flip = (x + y) % 3 === 0;
    else if (mask === 4) flip = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    else if (mask === 5) flip = ((x * y) % 2 + (x * y) % 3) === 0;
    else if (mask === 6) flip = (((x * y) % 2 + (x * y) % 3) % 2) === 0;
    else flip = (((x + y) % 2 + (x * y) % 3) % 2) === 0;
    m[y][x] = flip ? 1 - m[y][x] : m[y][x];
  }
  return m;
}

export function qrMatrix(text) {
  const data = dataCodewords(text);
  const ecc = reedSolomon(data);
  const base = makeMatrix();
  placeData(base, [...data, ...ecc]);
  let best = null, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = maskedCopy(base, mask);
    drawFormat(m, mask);
    const penalty = maskPenalty(m);
    if (penalty < bestPenalty) { best = m; bestPenalty = penalty; }
  }
  return best;
}

export const QR_SIZE = SIZE;
