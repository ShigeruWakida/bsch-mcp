// SVG renderer for BSch3V schematics

import type {
  Schematic, Component, PatternElement, PatternBlock,
} from './types.js';

const GRID = 10;
const COLORS = {
  background: '#ffffff',
  wire: '#008000',
  bus: '#0000ff',
  junction: '#008000',
  component: '#800000',
  componentFill: 'none',
  pinName: '#000000',
  pinNum: '#000000',
  text: '#000000',
  dash: '#000000',
  tag: '#800000',
  tagFill: '#ffffff',
  label: '#008000',
};

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function componentBodyRect(comp: Component): { l: number; t: number; w: number; h: number } {
  const cd = comp.embeddedLib?.components?.[0];
  let w = cd ? cd.X * GRID : 20;
  let h = cd ? cd.Y * GRID : 20;
  if (comp.props.DIR & 1) { const tmp = w; w = h; h = tmp; }
  return { l: comp.props.X - w, t: comp.props.Y - h, w, h };
}

function renderPatternElement(el: PatternElement, scaleX: number, scaleY: number): string {
  const sx = (x: number) => x * scaleX;
  const sy = (y: number) => y * scaleY;

  switch (el.type) {
    case 'L': {
      if (el.points.length < 2) return '';
      const d = el.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.X).toFixed(1)},${sy(p.Y).toFixed(1)}`).join(' ');
      return `<path d="${d}" stroke="${COLORS.component}" stroke-width="${el.W}" fill="none"/>`;
    }
    case 'PG': {
      const pts = el.points.map(p => `${sx(p.X).toFixed(1)},${sy(p.Y).toFixed(1)}`).join(' ');
      const fill = el.F === 1 ? COLORS.component : (el.F === -1 ? 'none' : COLORS.component);
      return `<polygon points="${pts}" stroke="${COLORS.component}" stroke-width="${el.W}" fill="${fill}"/>`;
    }
    case 'C': {
      if (el.points.length < 2) return '';
      const x1 = sx(el.points[0].X), y1 = sy(el.points[0].Y);
      const x2 = sx(el.points[1].X), y2 = sy(el.points[1].Y);
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      const fill = el.F === 1 ? COLORS.component : 'none';
      return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" stroke="${COLORS.component}" stroke-width="${el.W}" fill="${fill}"/>`;
    }
    case 'AR': {
      const cx = sx(el.X), cy = sy(el.Y), r = sx(el.R);
      const startAngle = el.B / 16 * Math.PI / 180;
      const endAngle = el.E / 16 * Math.PI / 180;
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy - r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy - r * Math.sin(endAngle);
      let sweep = endAngle - startAngle;
      if (sweep < 0) sweep += 2 * Math.PI;
      const largeArc = sweep > Math.PI ? 1 : 0;
      return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 ${largeArc} 0 ${x2.toFixed(1)},${y2.toFixed(1)}" stroke="${COLORS.component}" stroke-width="${el.W}" fill="none"/>`;
    }
    case 'TX': {
      const x = sx(el.X), y = sy(el.Y);
      const fontSize = el.FS ?? 10;
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fontSize * scaleX}" fill="${COLORS.text}" font-family="sans-serif">${escapeXml(el.S)}</text>`;
    }
    case 'BMP':
      return ''; // Skip bitmap rendering
  }
}

function getTransform(comp: Component, bodyW: number, bodyH: number): string {
  const dir = comp.props.DIR;
  const rot = dir & 3;
  const mirror = (dir & 4) !== 0;

  const cd = comp.embeddedLib?.components?.[0];
  const origW = cd ? cd.X * GRID : 20;
  const origH = cd ? cd.Y * GRID : 20;

  // Body top-left
  const bl = comp.props.X - bodyW;
  const bt = comp.props.Y - bodyH;
  const cx = bl + bodyW / 2;
  const cy = bt + bodyH / 2;

  const transforms: string[] = [];
  transforms.push(`translate(${bl},${bt})`);

  if (rot !== 0 || mirror) {
    // Move origin to center, apply transforms, move back
    const hw = bodyW / 2, hh = bodyH / 2;
    transforms.length = 0;
    transforms.push(`translate(${cx},${cy})`);
    if (mirror) transforms.push(`scale(-1,1)`);
    if (rot === 1) transforms.push(`rotate(90)`);
    else if (rot === 2) transforms.push(`rotate(180)`);
    else if (rot === 3) transforms.push(`rotate(270)`);
    transforms.push(`translate(${-origW / 2},${-origH / 2})`);
  }

  return transforms.join(' ');
}

function renderComponent(comp: Component): string {
  const parts: string[] = [];
  const body = componentBodyRect(comp);
  const cd = comp.embeddedLib?.components?.[0];

  if (!cd) return '';

  const origW = cd.X * GRID;
  const origH = cd.Y * GRID;
  const ptn = comp.embeddedLib?.patterns?.[0];

  if (ptn && ptn.elements.length > 0) {
    // Render pattern elements
    const scaleX = origW / (ptn.X - 1 || 1);
    const scaleY = origH / (ptn.Y - 1 || 1);
    const transform = getTransform(comp, body.w, body.h);
    parts.push(`<g transform="${transform}">`);
    for (const el of ptn.elements) {
      const svg = renderPatternElement(el, scaleX, scaleY);
      if (svg) parts.push(svg);
    }
    parts.push('</g>');
  } else {
    // No pattern: draw simple rectangle
    parts.push(`<rect x="${body.l}" y="${body.t}" width="${body.w}" height="${body.h}" stroke="${COLORS.component}" fill="none" stroke-width="1"/>`);
  }

  // Render pin lines and numbers
  const dir = comp.props.DIR;
  const block = comp.props.BLK;
  for (const pin of cd.pins) {
    const sideChar = pin.L[0];
    const offset = parseInt(pin.L.substring(1), 10) * GRID;

    let baseLtrb: number;
    switch (sideChar) {
      case 'L': baseLtrb = 0; break;
      case 'T': baseLtrb = 1; break;
      case 'R': baseLtrb = 2; break;
      case 'B': baseLtrb = 3; break;
      default: continue;
    }

    let nLtrb = (baseLtrb + (dir & 3)) & 3;
    if (dir & 4) {
      if (nLtrb === 0) nLtrb = 2;
      else if (nLtrb === 2) nLtrb = 0;
    }

    // Pin location (on body edge)
    let px: number, py: number;
    switch (nLtrb) {
      case 0: // L
        px = body.l;
        py = (dir === 2 || dir === 3 || dir === 6 || dir === 7) ? comp.props.Y - offset : comp.props.Y - body.h + offset;
        break;
      case 1: // T
        py = body.t;
        px = (dir === 1 || dir === 2 || dir === 4 || dir === 7) ? comp.props.X - offset : comp.props.X - body.w + offset;
        break;
      case 2: // R
        px = comp.props.X;
        py = (dir === 2 || dir === 3 || dir === 6 || dir === 7) ? comp.props.Y - offset : comp.props.Y - body.h + offset;
        break;
      default: // B
        py = comp.props.Y;
        px = (dir === 1 || dir === 2 || dir === 4 || dir === 7) ? comp.props.X - offset : comp.props.X - body.w + offset;
        break;
    }

    // Pin end (tip)
    const pinType = pin.T;
    const isZeroLen = pinType.includes('Z');
    const isSmall = pinType.includes('S');
    const pinLen = isZeroLen ? 0 : GRID;
    let ex = px, ey = py;
    if (!isZeroLen) {
      switch (nLtrb) {
        case 0: ex = px - pinLen; break;
        case 1: ey = py - pinLen; break;
        case 2: ex = px + pinLen; break;
        default: ey = py + pinLen; break;
      }
    }

    // Draw pin line
    if (pinLen > 0) {
      parts.push(`<line x1="${px}" y1="${py}" x2="${ex}" y2="${ey}" stroke="${COLORS.component}" stroke-width="1"/>`);
    }

    // Draw pin number
    const pinNum = pin.M[block] ?? pin.M[0] ?? '';
    if (pinNum && !pinType.includes('m')) {
      let tx = ex, ty = ey;
      let anchor = 'middle';
      switch (nLtrb) {
        case 0: tx = ex - 2; anchor = 'end'; ty += 3; break;
        case 1: ty = ey - 2; anchor = 'middle'; tx += 0; break;
        case 2: tx = ex + 2; anchor = 'start'; ty += 3; break;
        default: ty = ey + 8; anchor = 'middle'; break;
      }
      parts.push(`<text x="${tx}" y="${ty}" font-size="7" fill="${COLORS.pinNum}" text-anchor="${anchor}" font-family="sans-serif">${escapeXml(pinNum)}</text>`);
    }

    // Draw pin name
    if (pin.N && !isSmall) {
      let tx = px, ty = py;
      let anchor = 'start';
      switch (nLtrb) {
        case 0: tx = px + 2; ty += 3; anchor = 'start'; break;
        case 1: tx += 3; ty = py + 8; anchor = 'start'; break;
        case 2: tx = px - 2; ty += 3; anchor = 'end'; break;
        default: tx += 3; ty = py - 2; anchor = 'start'; break;
      }
      parts.push(`<text x="${tx}" y="${ty}" font-size="7" fill="${COLORS.pinName}" text-anchor="${anchor}" font-family="sans-serif">${escapeXml(pin.N)}</text>`);
    }
  }

  // Component name
  if (!comp.props.NH && comp.props.N) {
    const nx = comp.props.X + comp.props.NX;
    const ny = comp.props.Y + comp.props.NY;
    parts.push(`<text x="${nx}" y="${ny}" font-size="8" fill="${COLORS.text}" font-family="sans-serif">${escapeXml(comp.props.N)}</text>`);
  }

  // Reference designator
  if (!comp.props.RH && comp.props.R) {
    const rx = comp.props.X + comp.props.RX;
    const ry = comp.props.Y + comp.props.RY;
    parts.push(`<text x="${rx}" y="${ry}" font-size="8" fill="${COLORS.text}" font-family="sans-serif">${escapeXml(comp.props.R)}</text>`);
  }

  return parts.join('\n');
}

export function renderSchematicToSvg(sch: Schematic): string {
  const W = sch.sheetInfo.W;
  const H = sch.sheetInfo.H;
  const parts: string[] = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${COLORS.background}"/>`);

  // Wires
  for (const w of sch.wires) {
    parts.push(`<line x1="${w.X1}" y1="${w.Y1}" x2="${w.X2}" y2="${w.Y2}" stroke="${COLORS.wire}" stroke-width="1"/>`);
  }

  // Buses
  for (const b of sch.buses) {
    parts.push(`<line x1="${b.X1}" y1="${b.Y1}" x2="${b.X2}" y2="${b.Y2}" stroke="${COLORS.bus}" stroke-width="3"/>`);
  }

  // Bus entries / entries
  for (const be of [...sch.busEntries, ...sch.entries]) {
    parts.push(`<line x1="${be.X1}" y1="${be.Y1}" x2="${be.X2}" y2="${be.Y2}" stroke="${COLORS.wire}" stroke-width="1"/>`);
  }

  // Junctions
  for (const j of sch.junctions) {
    parts.push(`<circle cx="${j.X}" cy="${j.Y}" r="3" fill="${COLORS.junction}"/>`);
  }

  // Dashes (decorative lines)
  for (const d of sch.dashes) {
    const dashArray = d.LS === 'DASH' ? '5,3' : d.LS === 'LDT' ? '8,3,2,3' : d.LS === 'LDDT' ? '8,3,2,3,2,3' : '';
    parts.push(`<line x1="${d.X1}" y1="${d.Y1}" x2="${d.X2}" y2="${d.Y2}" stroke="${COLORS.dash}" stroke-width="${d.WDT ?? 1}" ${dashArray ? `stroke-dasharray="${dashArray}"` : ''}/>`);
  }

  // Markers
  for (const m of sch.markers) {
    const r = (m.CLR >> 16) & 0xff;
    const g = (m.CLR >> 8) & 0xff;
    const b = m.CLR & 0xff;
    parts.push(`<line x1="${m.X1}" y1="${m.Y1}" x2="${m.X2}" y2="${m.Y2}" stroke="rgb(${r},${g},${b})" stroke-width="${m.WDT}"/>`);
  }

  // Components
  for (const comp of sch.components) {
    parts.push(renderComponent(comp));
  }

  // Tags
  for (const tag of sch.tags) {
    const len = tag.S.length;
    const narrayTagWidth = [20, 20, 30, 40, 50, 60, 70, 80, 80, 90, 100, 110, 120];
    const w = len <= 12 ? narrayTagWidth[len] : Math.floor((len * 8 + 29) / 10) * 10;

    if (tag.D === 1) { // horizontal
      parts.push(`<rect x="${tag.X}" y="${tag.Y - 5}" width="${w}" height="10" stroke="${COLORS.tag}" fill="${COLORS.tagFill}" stroke-width="1"/>`);
      parts.push(`<text x="${tag.X + 2}" y="${tag.Y + 3}" font-size="8" fill="${COLORS.tag}" font-family="sans-serif">${escapeXml(tag.S)}</text>`);
    } else { // vertical
      parts.push(`<rect x="${tag.X - 5}" y="${tag.Y - w}" width="10" height="${w}" stroke="${COLORS.tag}" fill="${COLORS.tagFill}" stroke-width="1"/>`);
      parts.push(`<text x="${tag.X}" y="${tag.Y - 2}" font-size="8" fill="${COLORS.tag}" font-family="sans-serif" transform="rotate(-90,${tag.X},${tag.Y})">${escapeXml(tag.S)}</text>`);
    }
  }

  // Labels
  for (const label of sch.labels) {
    parts.push(`<text x="${label.X}" y="${label.Y + 3}" font-size="8" fill="${COLORS.label}" font-family="sans-serif">${escapeXml(label.S)}</text>`);
  }

  // Comments
  for (const c of sch.comments) {
    const fontSize = c.FS ?? 10;
    const bold = c.FF?.includes('B') ? 'font-weight="bold"' : '';
    const italic = c.FF?.includes('I') ? 'font-style="italic"' : '';
    parts.push(`<text x="${c.X}" y="${c.Y + fontSize}" font-size="${fontSize}" fill="${COLORS.text}" font-family="sans-serif" ${bold} ${italic}>${escapeXml(c.S)}</text>`);
  }

  parts.push('</svg>');
  return parts.join('\n');
}
