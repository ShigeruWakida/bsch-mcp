// CE3 format serializer - converts Schematic objects back to CE3 text

import { encodeValue } from './parser.js';
import type {
  Schematic, Component, EmbeddedLibrary, PatternBlock, CompBlock,
  Pin, PatternElement,
} from './types.js';

function serializeVars(vars: [string, string | number | undefined][]): string {
  return vars
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

function serializePatternElement(el: PatternElement): string {
  switch (el.type) {
    case 'L': {
      const coords = el.points.map(p => `X:${p.X},Y:${p.Y}`).join(',');
      return `+L,W:${el.W},S:${el.S},${coords},-L`;
    }
    case 'AR':
      return `+AR,W:${el.W},S:${el.S},X:${el.X},Y:${el.Y},R:${el.R},B:${el.B},E:${el.E},-AR`;
    case 'PG': {
      const coords = el.points.map(p => `X:${p.X},Y:${p.Y}`).join(',');
      return `+PG,W:${el.W},S:${el.S},F:${el.F},N:${el.N},${coords},-PG`;
    }
    case 'C': {
      const coords = el.points.map(p => `X:${p.X},Y:${p.Y}`).join(',');
      return `+C,W:${el.W},S:${el.S},F:${el.F},${coords},-C`;
    }
    case 'TX': {
      const parts = [`+TX`, `X:${el.X}`, `Y:${el.Y}`, `A:${el.A}`, `D:${el.D}`, `S:${encodeValue(el.S)}`];
      if (el.FN) parts.push(`FN:${encodeValue(el.FN)}`);
      if (el.FS !== undefined) parts.push(`FS:${el.FS}`);
      if (el.FF) parts.push(`FF:${el.FF}`);
      parts.push(`-TX`);
      return parts.join(',');
    }
    case 'BMP':
      return `+BMP\r\n${el.data}\r\n-BMP`;
  }
}

function serializePattern(ptn: PatternBlock): string {
  const elements = ptn.elements.map(serializePatternElement).join('\r\n');
  return `+PTN,N:${encodeValue(ptn.N)},X:${ptn.X},Y:${ptn.Y}\r\n${elements}\r\n-PTN`;
}

function serializePin(pin: Pin): string {
  const parts = [`+PIN`, `N:${encodeValue(pin.N)}`];
  if (pin.DF) parts.push(`DF:${pin.DF}`);
  parts.push(`L:${pin.L}`);
  parts.push(`T:${pin.T}`);
  for (const m of pin.M) {
    parts.push(`M:${m}`);
  }
  parts.push(`-PIN`);
  return parts.join(',');
}

function serializeComp(comp: CompBlock): string {
  const lines: string[] = [];
  lines.push(`+COMP,N:${encodeValue(comp.N)}`);
  lines.push(`X:${comp.X},Y:${comp.Y},B:${comp.B}`);
  lines.push(`R:${encodeValue(comp.R)}`);
  if (comp.P) lines.push(`P:${encodeValue(comp.P)}`);
  for (const pin of comp.pins) {
    lines.push(serializePin(pin));
  }
  const noteVars: string[] = [];
  if (comp.NOTE !== undefined) noteVars.push(`NOTE:${encodeValue(comp.NOTE)}`);
  if (comp.MFR !== undefined) noteVars.push(`MFR:${encodeValue(comp.MFR)}`);
  if (comp.MFRPN !== undefined) noteVars.push(`MFRPN:${encodeValue(comp.MFRPN)}`);
  if (comp.PKG !== undefined) noteVars.push(`PKG:${encodeValue(comp.PKG)}`);
  if (noteVars.length > 0) {
    lines.push(noteVars.join(',') + ',-COMP');
  } else {
    lines.push('-COMP');
  }
  return lines.join('\r\n');
}

function serializeEmbeddedLib(lib: EmbeddedLibrary): string {
  const lines: string[] = [];
  lines.push('+BSCH3_LIB_V.1.0');
  if (lib.VER !== undefined) lines.push(`VER:${lib.VER}`);
  for (const ptn of lib.patterns) {
    lines.push(serializePattern(ptn));
  }
  for (const comp of lib.components) {
    lines.push(serializeComp(comp));
  }
  lines.push('-BSCH3_LIB_V.1.0');
  return lines.join('\r\n');
}

function serializeComponent(comp: Component): string {
  const lines: string[] = [];
  lines.push('+COMPONENT');
  if (comp.embeddedLib) {
    lines.push(serializeEmbeddedLib(comp.embeddedLib));
  }
  const p = comp.props;
  const vars = serializeVars([
    ['L', p.L], ['X', p.X], ['Y', p.Y],
    ['LIB', encodeValue(p.LIB)], ['DIR', p.DIR], ['BLK', p.BLK],
    ['N', encodeValue(p.N)], ['ND', p.ND], ['NX', p.NX], ['NY', p.NY], ['NH', p.NH],
    ['R', encodeValue(p.R)], ['RD', p.RD], ['RX', p.RX], ['RY', p.RY], ['RH', p.RH],
    ['NOTE', encodeValue(p.NOTE)],
    ['PKG', encodeValue(p.PKG)], ['MFR', encodeValue(p.MFR)], ['MFRPN', encodeValue(p.MFRPN)],
  ]);
  lines.push(vars + ',-COMPONENT');
  return lines.join('\r\n');
}

export function serializeSchematic(sch: Schematic): string {
  const lines: string[] = [];
  lines.push('+BSCH3_DATA_V.1.0');

  // Sheet info
  const si = sch.sheetInfo;
  lines.push(`+SHEETINFO,${serializeVars([
    ['EL', si.EL], ['VL', si.VL], ['W', si.W], ['H', si.H],
    ['PROJ', encodeValue(si.PROJ)], ['PAGES', si.PAGES], ['PAGE', si.PAGE],
    ['VER', si.VER], ['INITPOS', si.INITPOS],
  ])},-SHEETINFO`);

  // Components
  for (const comp of sch.components) {
    lines.push(serializeComponent(comp));
  }

  // Junctions
  for (const j of sch.junctions) {
    lines.push(`+JUNCTION,L:${j.L},X:${j.X},Y:${j.Y},-JUNCTION`);
  }

  // Wires
  for (const w of sch.wires) {
    lines.push(`+WIRE,L:${w.L},X1:${w.X1},Y1:${w.Y1},X2:${w.X2},Y2:${w.Y2},-WIRE`);
  }

  // Buses
  for (const b of sch.buses) {
    lines.push(`+BUS,L:${b.L},X1:${b.X1},Y1:${b.Y1},X2:${b.X2},Y2:${b.Y2},-BUS`);
  }

  // Bus entries
  for (const be of sch.busEntries) {
    lines.push(`+BENTRY,L:${be.L},X1:${be.X1},Y1:${be.Y1},X2:${be.X2},Y2:${be.Y2},-BENTRY`);
  }

  // Entries
  for (const e of sch.entries) {
    lines.push(`+ENTRY,L:${e.L},X1:${e.X1},Y1:${e.Y1},X2:${e.X2},Y2:${e.Y2},-ENTRY`);
  }

  // Dashes
  for (const d of sch.dashes) {
    const vars: [string, string | number | undefined][] = [
      ['L', d.L], ['X1', d.X1], ['Y1', d.Y1], ['X2', d.X2], ['Y2', d.Y2],
    ];
    if (d.CURV !== undefined) vars.push(['CURV', d.CURV]);
    if (d.CTX1 !== undefined) vars.push(['CTX1', d.CTX1]);
    if (d.CTY1 !== undefined) vars.push(['CTY1', d.CTY1]);
    if (d.CTX2 !== undefined) vars.push(['CTX2', d.CTX2]);
    if (d.CTY2 !== undefined) vars.push(['CTY2', d.CTY2]);
    if (d.WDT !== undefined) vars.push(['WDT', d.WDT]);
    if (d.LS) vars.push(['LS', d.LS]);
    if (d.SSTL) vars.push(['SSTL', d.SSTL]);
    if (d.ESTL) vars.push(['ESTL', d.ESTL]);
    if (d.EMS !== undefined) vars.push(['EMS', d.EMS]);
    lines.push(`+DASH,${serializeVars(vars)},-DASH`);
  }

  // Markers
  for (const m of sch.markers) {
    lines.push(`+ALINE,L:${m.L},X1:${m.X1},Y1:${m.Y1},X2:${m.X2},Y2:${m.Y2},STL:${m.STL},WDT:${m.WDT},CLR:${m.CLR},-ALINE`);
  }

  // Tags
  for (const t of sch.tags) {
    lines.push(`+TAG,L:${t.L},X:${t.X},Y:${t.Y},D:${t.D},T:${t.T},S:${encodeValue(t.S)},-TAG`);
  }

  // Labels
  for (const l of sch.labels) {
    lines.push(`+LABEL,L:${l.L},X:${l.X},Y:${l.Y},D:${l.D},S:${encodeValue(l.S)},-LABEL`);
  }

  // Comments
  for (const c of sch.comments) {
    const vars: [string, string | number | undefined][] = [
      ['L', c.L], ['X', c.X], ['Y', c.Y], ['W', c.W], ['S', encodeValue(c.S)],
    ];
    if (c.FN) vars.push(['FN', encodeValue(c.FN)]);
    if (c.TAG !== undefined) vars.push(['TAG', c.TAG]);
    if (c.FS !== undefined) vars.push(['FS', c.FS]);
    if (c.FF) vars.push(['FF', c.FF]);
    lines.push(`+COMMENT,${serializeVars(vars)},-COMMENT`);
  }

  // Images
  for (const img of sch.images) {
    const imgLines: string[] = [];
    imgLines.push(`+IMAGEOBJECT`);
    imgLines.push(`L:${img.L},X:${img.X},Y:${img.Y}`);
    if (img.MAG !== undefined) imgLines.push(`MAG:${img.MAG}`);
    if (img.IMAGE_DIB) {
      imgLines.push(`+IMAGE_DIB`);
      imgLines.push(img.IMAGE_DIB);
      imgLines.push(`-IMAGE_DIB`);
    }
    imgLines.push(`-IMAGEOBJECT`);
    lines.push(imgLines.join('\r\n'));
  }

  lines.push('-BSCH3_DATA_V.1.0');
  return lines.join('\r\n') + '\r\n';
}
