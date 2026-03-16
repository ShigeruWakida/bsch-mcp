// CE3/LB3 text format parser

import type {
  Schematic, SheetInfo, Component, ComponentProps, Wire, Bus, Dash,
  Marker, Junction, BusEntry, Entry, Tag, Label, Comment, ImageObject,
  Library, PatternBlock, CompBlock, Pin, PatternElement, EmbeddedLibrary,
} from './types.js';

// Decode %XX escape sequences in record values
function decodeValue(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

// Encode special characters to %XX
export function encodeValue(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x25 || code === 0x2c) {
      result += '%' + code.toString(16).toUpperCase().padStart(2, '0');
    } else {
      result += s[i];
    }
  }
  return result;
}

interface Token {
  type: 'block_start' | 'block_end' | 'variable';
  label?: string;
  name?: string;
  value?: string;
}

// Tokenize a CE3/LB3 text into records, then into tokens
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];

  // Split into records by newline or comma
  const records: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r' || ch === ',') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        records.push(trimmed);
      }
      current = '';
      if (ch === '\r' && text[i + 1] === '\n') i++; // skip CRLF
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) records.push(trimmed);

  for (const rec of records) {
    if (rec.startsWith('+')) {
      tokens.push({ type: 'block_start', label: rec.substring(1) });
    } else if (rec.startsWith('-')) {
      tokens.push({ type: 'block_end', label: rec.substring(1) });
    } else {
      const colonIdx = rec.indexOf(':');
      if (colonIdx > 0) {
        tokens.push({
          type: 'variable',
          name: rec.substring(0, colonIdx),
          value: rec.substring(colonIdx + 1),
        });
      }
    }
  }

  return tokens;
}

// Parser state
class TokenReader {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : null;
  }

  next(): Token | null {
    return this.pos < this.tokens.length ? this.tokens[this.pos++] : null;
  }

  // Read variables until block_end with given label, consuming the block_end
  readVarsUntilEnd(label: string): Map<string, string[]> {
    const vars = new Map<string, string[]>();
    while (true) {
      const tok = this.peek();
      if (!tok) break;
      if (tok.type === 'block_end' && tok.label === label) {
        this.next(); // consume block_end
        break;
      }
      if (tok.type === 'variable') {
        this.next();
        const name = tok.name!;
        const existing = vars.get(name);
        if (existing) {
          existing.push(tok.value ?? '');
        } else {
          vars.set(name, [tok.value ?? '']);
        }
      } else if (tok.type === 'block_start') {
        // sub-block - skip for now in simple reads
        break;
      } else {
        this.next();
      }
    }
    return vars;
  }

  // Skip until block_end with given label (for unknown blocks)
  skipBlock(label: string): void {
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (!tok) break;
      if (tok.type === 'block_start') depth++;
      if (tok.type === 'block_end') {
        depth--;
        if (depth === 0 && tok.label === label) break;
      }
    }
  }
}

function getStr(vars: Map<string, string[]>, key: string, def = ''): string {
  const vals = vars.get(key);
  return vals && vals.length > 0 ? decodeValue(vals[0]) : def;
}

function getNum(vars: Map<string, string[]>, key: string, def = 0): number {
  const vals = vars.get(key);
  if (!vals || vals.length === 0) return def;
  const n = parseInt(vals[0], 10);
  return isNaN(n) ? def : n;
}

function parsePin(reader: TokenReader): Pin {
  const vars = new Map<string, string[]>();
  const mValues: string[] = [];

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'PIN') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      if (tok.name === 'M') {
        mValues.push(tok.value ?? '');
      } else {
        vars.set(tok.name!, [tok.value ?? '']);
      }
    } else {
      reader.next();
    }
  }

  return {
    N: getStr(vars, 'N'),
    L: getStr(vars, 'L'),
    T: getStr(vars, 'T'),
    DF: getStr(vars, 'DF') || undefined,
    M: mValues,
  };
}

function parsePatternBlock(reader: TokenReader): PatternBlock {
  const elements: PatternElement[] = [];
  let N = '', X = 0, Y = 0;

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'PTN') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      if (tok.name === 'N') N = decodeValue(tok.value ?? '');
      else if (tok.name === 'X') X = parseInt(tok.value ?? '0', 10);
      else if (tok.name === 'Y') Y = parseInt(tok.value ?? '0', 10);
    } else if (tok.type === 'block_start') {
      reader.next();
      const label = tok.label!;
      if (label === 'L') {
        elements.push(parseLineElement(reader));
      } else if (label === 'AR') {
        elements.push(parseArcElement(reader));
      } else if (label === 'PG') {
        elements.push(parsePolygonElement(reader));
      } else if (label === 'C') {
        elements.push(parseCircleElement(reader));
      } else if (label === 'TX') {
        elements.push(parseTextElement(reader));
      } else if (label === 'BMP') {
        elements.push(parseBmpBlock(reader));
      } else {
        reader.skipBlock(label);
      }
    } else {
      reader.next();
    }
  }

  return { N, X, Y, elements };
}

function parseLineElement(reader: TokenReader): PatternElement {
  const points: { X: number; Y: number }[] = [];
  let W = 1, S = 0;
  let pendingX: number | null = null;

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'L') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      const val = parseInt(tok.value ?? '0', 10);
      if (tok.name === 'W') W = val;
      else if (tok.name === 'S') S = val;
      else if (tok.name === 'X') pendingX = val;
      else if (tok.name === 'Y' && pendingX !== null) {
        points.push({ X: pendingX, Y: val });
        pendingX = null;
      }
    } else {
      reader.next();
    }
  }

  return { type: 'L', W, S, points };
}

function parseArcElement(reader: TokenReader): PatternElement {
  const vars = reader.readVarsUntilEnd('AR');
  return {
    type: 'AR',
    W: getNum(vars, 'W', 1),
    S: getNum(vars, 'S'),
    X: getNum(vars, 'X'),
    Y: getNum(vars, 'Y'),
    R: getNum(vars, 'R'),
    B: getNum(vars, 'B'),
    E: getNum(vars, 'E'),
  };
}

function parsePolygonElement(reader: TokenReader): PatternElement {
  const points: { X: number; Y: number }[] = [];
  let W = 1, S = 0, F = -1, N = 0;
  let pendingX: number | null = null;
  let readN = false;

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'PG') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      const val = parseInt(tok.value ?? '0', 10);
      if (tok.name === 'W') W = val;
      else if (tok.name === 'S') S = val;
      else if (tok.name === 'F') F = val;
      else if (tok.name === 'N' && !readN) { N = val; readN = true; }
      else if (tok.name === 'X') pendingX = val;
      else if (tok.name === 'Y' && pendingX !== null) {
        points.push({ X: pendingX, Y: val });
        pendingX = null;
      }
    } else {
      reader.next();
    }
  }

  return { type: 'PG', W, S, F, N, points };
}

function parseCircleElement(reader: TokenReader): PatternElement {
  const points: { X: number; Y: number }[] = [];
  let W = 1, S = 0, F = -1;
  let pendingX: number | null = null;

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'C') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      const val = parseInt(tok.value ?? '0', 10);
      if (tok.name === 'W') W = val;
      else if (tok.name === 'S') S = val;
      else if (tok.name === 'F') F = val;
      else if (tok.name === 'X') pendingX = val;
      else if (tok.name === 'Y' && pendingX !== null) {
        points.push({ X: pendingX, Y: val });
        pendingX = null;
      }
    } else {
      reader.next();
    }
  }

  return { type: 'C', W, S, F, points };
}

function parseTextElement(reader: TokenReader): PatternElement {
  const vars = reader.readVarsUntilEnd('TX');
  return {
    type: 'TX',
    X: getNum(vars, 'X'),
    Y: getNum(vars, 'Y'),
    A: getNum(vars, 'A'),
    D: getNum(vars, 'D'),
    S: getStr(vars, 'S'),
    FN: getStr(vars, 'FN') || undefined,
    FS: vars.has('FS') ? getNum(vars, 'FS') : undefined,
    FF: getStr(vars, 'FF') || undefined,
  };
}

function parseBmpBlock(reader: TokenReader): PatternElement {
  // BMP block contains raw bitmap data lines until -BMP
  let data = '';
  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'BMP') {
      reader.next();
      break;
    }
    // BMP data is stored as variable-like tokens but is really raw data
    if (tok.type === 'variable') {
      reader.next();
      data += (tok.name ?? '') + ':' + (tok.value ?? '');
    } else {
      reader.next();
    }
  }
  return { type: 'BMP', data };
}

function parseCompBlock(reader: TokenReader): CompBlock {
  const pins: Pin[] = [];
  let N = '', R = '', P: string | undefined;
  let X = 0, Y = 0, B = 1;
  let NOTE: string | undefined;
  let MFR: string | undefined;
  let MFRPN: string | undefined;
  let PKG: string | undefined;

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'COMP') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      if (tok.name === 'N') N = decodeValue(tok.value ?? '');
      else if (tok.name === 'X') X = parseInt(tok.value ?? '0', 10);
      else if (tok.name === 'Y') Y = parseInt(tok.value ?? '0', 10);
      else if (tok.name === 'B') B = parseInt(tok.value ?? '1', 10);
      else if (tok.name === 'R') R = decodeValue(tok.value ?? '');
      else if (tok.name === 'P') P = decodeValue(tok.value ?? '');
      else if (tok.name === 'NOTE') NOTE = decodeValue(tok.value ?? '');
      else if (tok.name === 'MFR') MFR = decodeValue(tok.value ?? '');
      else if (tok.name === 'MFRPN') MFRPN = decodeValue(tok.value ?? '');
      else if (tok.name === 'PKG') PKG = decodeValue(tok.value ?? '');
    } else if (tok.type === 'block_start' && tok.label === 'PIN') {
      reader.next();
      pins.push(parsePin(reader));
    } else {
      reader.next();
    }
  }

  return { N, X, Y, B, R, P, pins, NOTE, MFR, MFRPN, PKG };
}

function parseEmbeddedLibrary(reader: TokenReader): EmbeddedLibrary {
  const patterns: PatternBlock[] = [];
  const components: CompBlock[] = [];
  let VER: number | undefined;

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'BSCH3_LIB_V.1.0') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      if (tok.name === 'VER') VER = parseInt(tok.value ?? '0', 10);
    } else if (tok.type === 'block_start') {
      reader.next();
      if (tok.label === 'PTN') {
        patterns.push(parsePatternBlock(reader));
      } else if (tok.label === 'COMP') {
        components.push(parseCompBlock(reader));
      } else {
        reader.skipBlock(tok.label!);
      }
    } else {
      reader.next();
    }
  }

  return { VER, patterns, components };
}

function parseComponentBlock(reader: TokenReader): Component {
  let embeddedLib: EmbeddedLibrary | undefined;
  const propVars = new Map<string, string[]>();

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'COMPONENT') {
      reader.next();
      break;
    }
    if (tok.type === 'block_start') {
      reader.next();
      if (tok.label === 'BSCH3_LIB_V.1.0') {
        embeddedLib = parseEmbeddedLibrary(reader);
      } else {
        reader.skipBlock(tok.label!);
      }
    } else if (tok.type === 'variable') {
      reader.next();
      propVars.set(tok.name!, [tok.value ?? '']);
    } else {
      reader.next();
    }
  }

  const props: ComponentProps = {
    L: getNum(propVars, 'L'),
    X: getNum(propVars, 'X'),
    Y: getNum(propVars, 'Y'),
    LIB: getStr(propVars, 'LIB'),
    DIR: getNum(propVars, 'DIR'),
    BLK: getNum(propVars, 'BLK'),
    N: getStr(propVars, 'N'),
    ND: getNum(propVars, 'ND'),
    NX: getNum(propVars, 'NX'),
    NY: getNum(propVars, 'NY'),
    NH: getNum(propVars, 'NH'),
    R: getStr(propVars, 'R'),
    RD: getNum(propVars, 'RD'),
    RX: getNum(propVars, 'RX'),
    RY: getNum(propVars, 'RY'),
    RH: getNum(propVars, 'RH'),
    NOTE: getStr(propVars, 'NOTE'),
    PKG: getStr(propVars, 'PKG'),
    MFR: getStr(propVars, 'MFR'),
    MFRPN: getStr(propVars, 'MFRPN'),
  };

  return { props, embeddedLib };
}

function parseSimpleLineBlock(reader: TokenReader, label: string): Wire {
  const vars = reader.readVarsUntilEnd(label);
  return {
    L: getNum(vars, 'L'),
    X1: getNum(vars, 'X1'),
    Y1: getNum(vars, 'Y1'),
    X2: getNum(vars, 'X2'),
    Y2: getNum(vars, 'Y2'),
  };
}

export function parseSchematic(text: string): Schematic {
  const tokens = tokenize(text);
  const reader = new TokenReader(tokens);

  const schematic: Schematic = {
    sheetInfo: { EL: 0, VL: 255, W: 640, H: 400, PROJ: '', PAGES: 1, PAGE: 1, VER: 81, INITPOS: 0 },
    components: [],
    wires: [],
    buses: [],
    dashes: [],
    markers: [],
    junctions: [],
    busEntries: [],
    entries: [],
    tags: [],
    labels: [],
    comments: [],
    images: [],
  };

  // Expect +BSCH3_DATA_V.1.0
  const first = reader.next();
  if (!first || first.type !== 'block_start' || first.label !== 'BSCH3_DATA_V.1.0') {
    throw new Error('Invalid CE3 file: expected +BSCH3_DATA_V.1.0');
  }

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'BSCH3_DATA_V.1.0') {
      reader.next();
      break;
    }

    if (tok.type === 'block_start') {
      reader.next();
      const label = tok.label!;

      switch (label) {
        case 'SHEETINFO': {
          const vars = reader.readVarsUntilEnd('SHEETINFO');
          schematic.sheetInfo = {
            EL: getNum(vars, 'EL'),
            VL: getNum(vars, 'VL', 255),
            W: getNum(vars, 'W', 640),
            H: getNum(vars, 'H', 400),
            PROJ: getStr(vars, 'PROJ'),
            PAGES: getNum(vars, 'PAGES', 1),
            PAGE: getNum(vars, 'PAGE', 1),
            VER: getNum(vars, 'VER', 81),
            INITPOS: getNum(vars, 'INITPOS'),
          };
          break;
        }
        case 'COMPONENT':
          schematic.components.push(parseComponentBlock(reader));
          break;
        case 'WIRE':
          schematic.wires.push(parseSimpleLineBlock(reader, 'WIRE'));
          break;
        case 'BUS':
          schematic.buses.push(parseSimpleLineBlock(reader, 'BUS') as Bus);
          break;
        case 'DASH': {
          const vars = reader.readVarsUntilEnd('DASH');
          schematic.dashes.push({
            L: getNum(vars, 'L'),
            X1: getNum(vars, 'X1'), Y1: getNum(vars, 'Y1'),
            X2: getNum(vars, 'X2'), Y2: getNum(vars, 'Y2'),
            CURV: vars.has('CURV') ? getNum(vars, 'CURV') : undefined,
            CTX1: vars.has('CTX1') ? getNum(vars, 'CTX1') : undefined,
            CTY1: vars.has('CTY1') ? getNum(vars, 'CTY1') : undefined,
            CTX2: vars.has('CTX2') ? getNum(vars, 'CTX2') : undefined,
            CTY2: vars.has('CTY2') ? getNum(vars, 'CTY2') : undefined,
            WDT: vars.has('WDT') ? getNum(vars, 'WDT') : undefined,
            LS: getStr(vars, 'LS') || undefined,
            SSTL: getStr(vars, 'SSTL') || undefined,
            ESTL: getStr(vars, 'ESTL') || undefined,
            EMS: vars.has('EMS') ? getNum(vars, 'EMS') : undefined,
          });
          break;
        }
        case 'ALINE': {
          const vars = reader.readVarsUntilEnd('ALINE');
          schematic.markers.push({
            L: getNum(vars, 'L'),
            X1: getNum(vars, 'X1'), Y1: getNum(vars, 'Y1'),
            X2: getNum(vars, 'X2'), Y2: getNum(vars, 'Y2'),
            STL: getNum(vars, 'STL'),
            WDT: getNum(vars, 'WDT'),
            CLR: getNum(vars, 'CLR'),
          });
          break;
        }
        case 'JUNCTION': {
          const vars = reader.readVarsUntilEnd('JUNCTION');
          schematic.junctions.push({
            L: getNum(vars, 'L'),
            X: getNum(vars, 'X'),
            Y: getNum(vars, 'Y'),
          });
          break;
        }
        case 'BENTRY':
          schematic.busEntries.push(parseSimpleLineBlock(reader, 'BENTRY') as BusEntry);
          break;
        case 'ENTRY':
          schematic.entries.push(parseSimpleLineBlock(reader, 'ENTRY') as Entry);
          break;
        case 'TAG': {
          const vars = reader.readVarsUntilEnd('TAG');
          schematic.tags.push({
            L: getNum(vars, 'L'),
            X: getNum(vars, 'X'), Y: getNum(vars, 'Y'),
            D: getNum(vars, 'D'),
            T: getNum(vars, 'T'),
            S: getStr(vars, 'S'),
          });
          break;
        }
        case 'LABEL': {
          const vars = reader.readVarsUntilEnd('LABEL');
          schematic.labels.push({
            L: getNum(vars, 'L'),
            X: getNum(vars, 'X'), Y: getNum(vars, 'Y'),
            D: getNum(vars, 'D'),
            S: getStr(vars, 'S'),
          });
          break;
        }
        case 'COMMENT': {
          const vars = reader.readVarsUntilEnd('COMMENT');
          schematic.comments.push({
            L: getNum(vars, 'L'),
            X: getNum(vars, 'X'), Y: getNum(vars, 'Y'),
            W: getNum(vars, 'W', -1),
            S: getStr(vars, 'S'),
            FN: getStr(vars, 'FN') || undefined,
            TAG: vars.has('TAG') ? getNum(vars, 'TAG') : undefined,
            FS: vars.has('FS') ? getNum(vars, 'FS') : undefined,
            FF: getStr(vars, 'FF') || undefined,
          });
          break;
        }
        case 'IMAGEOBJECT': {
          const img: ImageObject = { L: 0, X: 0, Y: 0 };
          while (true) {
            const t = reader.peek();
            if (!t) break;
            if (t.type === 'block_end' && t.label === 'IMAGEOBJECT') {
              reader.next();
              break;
            }
            if (t.type === 'variable') {
              reader.next();
              if (t.name === 'L') img.L = parseInt(t.value ?? '0', 10);
              else if (t.name === 'X') img.X = parseInt(t.value ?? '0', 10);
              else if (t.name === 'Y') img.Y = parseInt(t.value ?? '0', 10);
              else if (t.name === 'MAG') img.MAG = parseInt(t.value ?? '100', 10);
            } else if (t.type === 'block_start' && t.label === 'IMAGE_DIB') {
              reader.next();
              // Read raw data until -IMAGE_DIB
              let data = '';
              while (true) {
                const dt = reader.peek();
                if (!dt) break;
                if (dt.type === 'block_end' && dt.label === 'IMAGE_DIB') {
                  reader.next();
                  break;
                }
                reader.next();
                if (dt.type === 'variable') {
                  data += (dt.name ?? '') + ':' + (dt.value ?? '') + '\n';
                }
              }
              img.IMAGE_DIB = data;
            } else {
              reader.next();
            }
          }
          schematic.images.push(img);
          break;
        }
        default:
          reader.skipBlock(label);
      }
    } else {
      reader.next();
    }
  }

  return schematic;
}

export function parseLibrary(text: string): Library {
  const tokens = tokenize(text);
  const reader = new TokenReader(tokens);

  const lib: Library = { patterns: [], components: [] };

  const first = reader.next();
  if (!first || first.type !== 'block_start' || first.label !== 'BSCH3_LIB_V.1.0') {
    throw new Error('Invalid LB3 file: expected +BSCH3_LIB_V.1.0');
  }

  while (true) {
    const tok = reader.peek();
    if (!tok) break;
    if (tok.type === 'block_end' && tok.label === 'BSCH3_LIB_V.1.0') {
      reader.next();
      break;
    }
    if (tok.type === 'variable') {
      reader.next();
      if (tok.name === 'VER') lib.VER = parseInt(tok.value ?? '0', 10);
      else if (tok.name === 'PROP') lib.PROP = decodeValue(tok.value ?? '');
    } else if (tok.type === 'block_start') {
      reader.next();
      if (tok.label === 'PTN') {
        lib.patterns.push(parsePatternBlock(reader));
      } else if (tok.label === 'COMP') {
        lib.components.push(parseCompBlock(reader));
      } else {
        reader.skipBlock(tok.label!);
      }
    } else {
      reader.next();
    }
  }

  return lib;
}
