// QR code for the WizardConnect link, for phone wallets that scan instead of paste.
//
// WizardConnect's `qrUri` is the same link upper-cased with ?, = and & percent-encoded, so every
// character is in the QR alphanumeric set: alphanumeric mode gives a smaller, easier-to-scan code
// than byte mode. Wallets decode it back (`decodeKeyExchangeURI` lower-cases and un-escapes).

import qrcode from 'qrcode-generator';

const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;
const SVG = 'http://www.w3.org/2000/svg';

export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, ALPHANUMERIC.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

// Built with DOM calls (no innerHTML): one path of 1x1 squares, a 4-module quiet zone, crisp edges.
export function qrSvg(text: string, label: string): SVGSVGElement {
  const m = qrModules(text);
  const n = m.length;
  const quiet = 4;
  const size = n + quiet * 2;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.classList.add('qr');
  const bg = document.createElementNS(SVG, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  svg.append(bg);
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  return svg;
}
