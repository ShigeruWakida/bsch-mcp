#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as iconv from 'iconv-lite';
import { parseSchematic, parseLibrary } from './parser.js';
import { serializeSchematic } from './serializer.js';
import { generateNetlist, pinEnd } from './netlist.js';
import type { Schematic, Component, Wire, Junction, Label, Tag, Comment, Bus, BusEntry, Entry, Dash, Marker } from './types.js';

// Detect encoding: check if valid UTF-8, otherwise assume CP932
function detectEncoding(buf: Buffer): string {
  try {
    const text = buf.toString('utf-8');
    // Check for replacement characters that indicate invalid UTF-8
    if (!text.includes('\uFFFD')) {
      // Verify by re-encoding: valid UTF-8 should round-trip
      const reEncoded = Buffer.from(text, 'utf-8');
      if (reEncoded.equals(buf)) return 'utf-8';
    }
  } catch {}
  return 'cp932';
}

// Helper: read a CE3/LB3 file (auto-detect encoding)
function readSchematicFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  const encoding = detectEncoding(buf);
  if (encoding === 'utf-8') {
    return buf.toString('utf-8');
  }
  return iconv.decode(buf, 'cp932');
}

// Helper: write a CE3/LB3 file (UTF-8)
function writeSchematicFile(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, 'utf-8');
}

// In-memory schematic state per file
const openSchematics = new Map<string, Schematic>();

// Find BSch3V installation directory
function findBsch3vDir(): string | null {
  // 1. Environment variable (from .mcp.json)
  const envDir = process.env.BSCH3V_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'BSCH3.INI'))) {
    return envDir;
  }

  // 2. Search common locations
  const candidates: string[] = [];

  // Same directory as this script
  candidates.push(path.resolve(__dirname, '..'));

  // Program Files
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  for (const pf of [programFiles, programFilesX86]) {
    candidates.push(path.join(pf, 'BSch3V'));
    candidates.push(path.join(pf, 'bsch3v'));
  }

  // User's home directory
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    candidates.push(path.join(home, 'BSch3V'));
    candidates.push(path.join(home, 'Documents', 'BSch3V'));
    candidates.push(path.join(home, 'Desktop', 'BSch3V'));
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'BSCH3.INI'))) {
      return dir;
    }
    // Also check for bsch3v.exe without INI
    if (fs.existsSync(path.join(dir, 'bsch3v.exe'))) {
      return dir;
    }
  }

  return null;
}

// Cached BSch3V directory
let _bsch3vDir: string | null | undefined;
function getBsch3vDir(): string | null {
  if (_bsch3vDir === undefined) {
    _bsch3vDir = findBsch3vDir();
  }
  return _bsch3vDir;
}

// Get INI path from BSch3V directory
function getIniPath(): string | null {
  const dir = getBsch3vDir();
  if (!dir) return null;
  const iniPath = path.join(dir, 'BSCH3.INI');
  return fs.existsSync(iniPath) ? iniPath : null;
}

const server = new McpServer({
  name: 'bsch3v-mcp',
  version: '1.0.0',
});

// --- Tools ---

// read_schematic: Read a CE3 file and return its structure as JSON
server.tool(
  'read_schematic',
  'Read a BSch3V CE3 schematic file and return its structure as JSON. Use excludeEmbeddedLib=true to omit large embedded library data (pattern graphics) for a compact output.',
  {
    filePath: z.string().describe('Absolute path to the CE3 file'),
    excludeEmbeddedLib: z.boolean().optional().describe('If true, omit embedded library data from components to reduce output size (default: false)'),
  },
  async ({ filePath, excludeEmbeddedLib }) => {
    try {
      const text = readSchematicFile(filePath);
      const sch = parseSchematic(text);
      openSchematics.set(path.resolve(filePath), sch);

      let output: unknown = sch;
      if (excludeEmbeddedLib) {
        output = {
          ...sch,
          components: sch.components.map(c => ({
            props: c.props,
            // Include only pin info from embedded lib, omit pattern graphics
            pins: c.embeddedLib?.components?.[0]?.pins ?? [],
            libComponentName: c.embeddedLib?.components?.[0]?.N,
            libComponentSize: c.embeddedLib?.components?.[0] ? {
              X: c.embeddedLib.components[0].X,
              Y: c.embeddedLib.components[0].Y,
            } : undefined,
          })),
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// write_schematic: Write the current schematic state to a CE3 file
server.tool(
  'write_schematic',
  'Write the in-memory schematic to a CE3 file. Must call read_schematic or create_schematic first to load data into memory. Output is UTF-8 with CR+LF line endings.',
  {
    filePath: z.string().describe('Absolute path to write the CE3 file'),
    sourcePath: z.string().optional().describe('Source file path key (if different from filePath)'),
  },
  async ({ filePath, sourcePath }) => {
    try {
      const key = path.resolve(sourcePath ?? filePath);
      const sch = openSchematics.get(key);
      if (!sch) {
        return { content: [{ type: 'text' as const, text: `Error: No schematic loaded for ${key}. Use read_schematic first or create_schematic.` }], isError: true };
      }
      const text = serializeSchematic(sch);
      writeSchematicFile(filePath, text);
      // Update key if writing to new path
      if (path.resolve(filePath) !== key) {
        openSchematics.set(path.resolve(filePath), sch);
      }
      return { content: [{ type: 'text' as const, text: `Schematic written to ${filePath}` }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// create_schematic: Create a new empty schematic
server.tool(
  'create_schematic',
  'Create a new empty BSch3V schematic in memory',
  {
    filePath: z.string().describe('Absolute path to associate with this schematic'),
    width: z.number().optional().describe('Sheet width in pixels (default 640)'),
    height: z.number().optional().describe('Sheet height in pixels (default 400)'),
  },
  async ({ filePath, width, height }) => {
    const sch: Schematic = {
      sheetInfo: {
        EL: 0, VL: 255,
        W: width ?? 640, H: height ?? 400,
        PROJ: '', PAGES: 1, PAGE: 1, VER: 81, INITPOS: 0,
      },
      components: [], wires: [], buses: [], dashes: [],
      markers: [], junctions: [], busEntries: [], entries: [],
      tags: [], labels: [], comments: [], images: [],
    };
    openSchematics.set(path.resolve(filePath), sch);
    return { content: [{ type: 'text' as const, text: `New schematic created for ${filePath} (${sch.sheetInfo.W}x${sch.sheetInfo.H})` }] };
  }
);

// read_library: Read an LB3 library file
server.tool(
  'read_library',
  'Read a BSch3V LB3 library file and return component/pin information as JSON',
  { filePath: z.string().describe('Absolute path to the LB3 file') },
  async ({ filePath }) => {
    try {
      const text = readSchematicFile(filePath);
      const lib = parseLibrary(text);
      return { content: [{ type: 'text' as const, text: JSON.stringify(lib, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// Parse BSCH3.INI to get library paths
function parseIniLibraries(iniPath: string): string[] {
  const buf = fs.readFileSync(iniPath);
  // BSCH3.INI is UTF-16LE
  let text: string;
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    text = buf.toString('utf16le');
  } else {
    // Try UTF-16LE without BOM (each ASCII char followed by 0x00)
    text = buf.toString('utf16le');
  }

  const iniDir = path.dirname(iniPath);
  const libs: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^LIB\d+=(.+)$/i);
    if (match) {
      const libPath = match[1].trim();
      if (libPath) {
        // Resolve relative to INI file directory
        const resolved = path.resolve(iniDir, libPath);
        if (fs.existsSync(resolved)) {
          libs.push(resolved);
        }
      }
    }
  }
  return libs;
}

// list_libraries: List LB3 files from a directory, BSCH3.INI, or auto-detect
server.tool(
  'list_libraries',
  'List available LB3 library files. If no parameters given, auto-detects BSch3V installation and reads BSCH3.INI.',
  {
    dirPath: z.string().optional().describe('Directory path to search for LB3 files'),
    iniPath: z.string().optional().describe('Path to BSCH3.INI to read configured library paths'),
  },
  async ({ dirPath, iniPath }) => {
    try {
      let files: string[] = [];
      if (iniPath) {
        files = parseIniLibraries(iniPath);
      } else if (dirPath) {
        files = fs.readdirSync(dirPath)
          .filter(f => f.toLowerCase().endsWith('.lb3'))
          .map(f => path.join(dirPath, f));
      } else {
        // Auto-detect from BSCH3.INI
        const autoIni = getIniPath();
        if (autoIni) {
          files = parseIniLibraries(autoIni);
        } else {
          return { content: [{ type: 'text' as const, text: 'Error: BSch3V installation not found. Specify dirPath, iniPath, or set BSCH3V_DIR environment variable.' }], isError: true };
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(files, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// get_library_component: Get a specific component from a library or CE3 as embeddedLibJson
server.tool(
  'get_library_component',
  `Get a component as embeddedLibJson for add_component. Searches LB3 libraries and/or CE3 schematic files.
If no file specified, auto-searches all libraries from BSCH3.INI.
Use schematicPath to copy components from existing CE3 files (searches by LIB name, not component name).
The returned JSON can be passed directly to add_component's embeddedLibJson parameter.`,
  {
    componentName: z.string().describe('Component name (LIB name) to find (e.g. "R", "LED", "7400", "NPN")'),
    filePath: z.string().optional().describe('LB3 or CE3 file path to search. If omitted, searches all libraries from BSCH3.INI'),
    schematicPath: z.string().optional().describe('CE3 schematic file to search for existing embedded components'),
  },
  async ({ componentName, filePath, schematicPath }) => {
    try {
      // 1. Search in specified CE3 schematic
      if (schematicPath) {
        const text = readSchematicFile(schematicPath);
        const sch = parseSchematic(text);
        const comp = sch.components.find(c => c.props.LIB === componentName && c.embeddedLib);
        if (comp && comp.embeddedLib) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(comp.embeddedLib) }] };
        }
      }

      // 2. Search in specified LB3 or auto-detected libraries
      let libFiles: string[];
      if (filePath) {
        libFiles = [filePath];
      } else {
        const autoIni = getIniPath();
        if (autoIni) {
          libFiles = parseIniLibraries(autoIni);
        } else if (!schematicPath) {
          return { content: [{ type: 'text' as const, text: 'Error: No filePath/schematicPath specified and BSch3V installation not found. Set BSCH3V_DIR environment variable.' }], isError: true };
        } else {
          // schematicPath was given but component not found there
          return { content: [{ type: 'text' as const, text: `Error: component "${componentName}" not found in ${schematicPath}` }], isError: true };
        }
      }

      for (const lf of libFiles) {
        const text = readSchematicFile(lf);
        const lib = parseLibrary(text);
        const comp = lib.components.find(c => c.N === componentName);
        if (comp) {
          const patterns = comp.P
            ? lib.patterns.filter(p => p.N === comp.P)
            : [];
          const embeddedLib = {
            VER: lib.VER,
            patterns,
            components: [comp],
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(embeddedLib) }] };
        }
      }

      // 3. Not found - list available components
      const allComponents: string[] = [];
      if (schematicPath) {
        try {
          const text = readSchematicFile(schematicPath);
          const sch = parseSchematic(text);
          const seen = new Set<string>();
          for (const c of sch.components) {
            if (!seen.has(c.props.LIB)) {
              seen.add(c.props.LIB);
              allComponents.push(`${c.props.LIB} (${path.basename(schematicPath)})`);
            }
          }
        } catch {}
      }
      for (const lf of libFiles) {
        try {
          const text = readSchematicFile(lf);
          const lib = parseLibrary(text);
          const libName = path.basename(lf);
          for (const c of lib.components) {
            allComponents.push(`${c.N} (${libName})`);
          }
        } catch {}
      }
      return { content: [{ type: 'text' as const, text: `Error: component "${componentName}" not found.\nAvailable:\n${allComponents.join('\n')}` }], isError: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// Helper to get schematic or error
function getSchematic(filePath: string): { sch: Schematic } | { error: string } {
  const key = path.resolve(filePath);
  const sch = openSchematics.get(key);
  if (!sch) return { error: `No schematic loaded for ${key}` };
  return { sch };
}

// add_component: Add a component to the schematic
server.tool(
  'add_component',
  `Add a component to the schematic. Requires embedded library data (embeddedLibJson).
How to get embeddedLibJson:
1. get_library_component(componentName) - search LB3 libraries automatically
2. get_library_component(componentName, schematicPath) - copy from existing CE3 file
3. create_component(name, pins) - create new rectangular IC from pin definitions
4. modify_library_component(componentName, ...) - modify existing component's pins
Position (x,y) is the RIGHT-BOTTOM corner of the component body. Grid = 10px.
Name/refdes position offsets are auto-copied from existing same-type components when available.
IMPORTANT: NEVER select a component just because it exists in the library. Always select the best component for the circuit requirements first, then find or create the symbol. If a pin-compatible symbol exists in the library (e.g. LM358 symbol for TL072), use modify_library_component to rename it.
IMPORTANT: After creating or modifying a schematic, ALWAYS run get_net_connections to verify all connections are correct before presenting to the user. Fix any issues found before saving.
JUNCTIONS: Place junctions where 3+ wires/pins meet at a T or cross point. Also required where a power symbol pin connects to a wire that continues past it. Do NOT place junctions just to work around routing issues.
WIRE SPLITTING: Splitting a wire into two segments at a point does NOT create a connection at that point in BSch3V. To connect a component pin to a wire, the pin must touch a wire ENDPOINT, or a junction must exist at that point.
POWER SYMBOLS: When connecting power symbols (VCC, GND, VEE), ensure the pin physically touches a wire endpoint or a junction exists at the connection point. Move the symbol if needed rather than splitting wires.
WIRE ROUTING: Wires must NEVER cross over or pass through component bodies. Route wires around components. This is a fundamental rule of schematic drawing.
MFB FILTER LAYOUT: For MFB (Multiple Feedback) active filters:
- Place op-amp with inverting input on top (use DIR=6 for mirror+180°, so (-) input faces upward toward feedback components)
- Place feedback capacitor (C2) horizontally (DIR=1) between the inverting input and output, above the op-amp
- Place the series resistor (R2) to the inverting input on the upper-left, connecting horizontally
- Place the feedback resistor (R3) above R2, routing horizontally to the output
- Place the filter capacitor (C1) vertically below the node A junction
- This creates a clean top-to-bottom signal flow: input → node A → op-amp → output, with feedback on top
GENERAL LAYOUT PRINCIPLES:
- Plan the entire layout before placing any components. Consider signal flow direction and feedback paths.
- Place components to minimize wire crossings and avoid wires passing through component bodies.
- Use consistent spacing between similar component groups (e.g., all resistor-LED-GND columns at equal intervals).
- Keep power supply section separate from signal path, typically at the bottom of the schematic.
- Route wires in straight horizontal/vertical lines. Minimize the number of bends.
- When multiple wires need to reach the same point, use a junction at the branch point rather than routing each wire independently.`,
  {
    filePath: z.string().describe('Schematic file path'),
    libName: z.string().describe('Library component name (e.g. "R", "LED", "VCC-3")'),
    x: z.number().describe('X coordinate (right-bottom of component)'),
    y: z.number().describe('Y coordinate (right-bottom of component)'),
    dir: z.number().optional().describe('Direction: 0=normal, 1=90deg, 2=180deg, 3=270deg, +8=mirror'),
    name: z.string().optional().describe('Component name (e.g. "74HC574")'),
    refdes: z.string().optional().describe('Reference designator (e.g. "U1", "R1")'),
    block: z.number().optional().describe('Block number (for multi-block components)'),
    embeddedLibJson: z.string().optional().describe('Embedded library JSON (from read_library, the component + its pattern)'),
  },
  async ({ filePath, libName, x, y, dir, name, refdes, block, embeddedLibJson }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    let embeddedLib: Component['embeddedLib'];
    if (embeddedLibJson) {
      try {
        embeddedLib = JSON.parse(embeddedLibJson);
      } catch {
        return { content: [{ type: 'text' as const, text: 'Error: Invalid embeddedLibJson' }], isError: true };
      }
    }

    // Use existing component with same lib as template for default positions
    const template = sch.components.find(c => c.props.LIB === libName);
    const tp = template?.props;

    const comp: Component = {
      props: {
        L: 0, X: x, Y: y,
        LIB: libName,
        DIR: dir ?? 0,
        BLK: block ?? 0,
        N: name ?? libName,
        ND: tp?.ND ?? 1,
        NX: tp?.NX ?? -19,
        NY: tp?.NY ?? -9,
        NH: tp?.NH ?? 0,
        R: refdes ?? '',
        RD: tp?.RD ?? 1,
        RX: tp?.RX ?? 2,
        RY: tp?.RY ?? 10,
        RH: tp?.RH ?? 0,
        NOTE: '', PKG: '', MFR: '', MFRPN: '',
      },
      embeddedLib,
    };
    sch.components.push(comp);

    return { content: [{ type: 'text' as const, text: `Component "${libName}" added at (${x}, ${y}). Total components: ${sch.components.length}` }] };
  }
);

// add_wire: Add a wire
server.tool(
  'add_wire',
  `Add a wire between two points. Wires must be horizontal or vertical (no diagonal).
Use get_component_pins to find pin connection points before wiring.
Wires connect at endpoints only - a pin must touch a wire endpoint to be electrically connected.
Use add_junction where wires cross and should connect.`,
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X'),
    y1: z.number().describe('Start Y'),
    x2: z.number().describe('End X'),
    y2: z.number().describe('End Y'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x1, y1, x2, y2, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const wire: Wire = { L: layer ?? 0, X1: x1, Y1: y1, X2: x2, Y2: y2 };
    sch.wires.push(wire);

    return { content: [{ type: 'text' as const, text: `Wire added (${x1},${y1})→(${x2},${y2}). Total wires: ${sch.wires.length}` }] };
  }
);

// add_junction: Add a junction
server.tool(
  'add_junction',
  'Add a junction (connection dot) at a point',
  {
    filePath: z.string().describe('Schematic file path'),
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x, y, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const junction: Junction = { L: layer ?? 0, X: x, Y: y };
    sch.junctions.push(junction);

    return { content: [{ type: 'text' as const, text: `Junction added at (${x},${y}). Total: ${sch.junctions.length}` }] };
  }
);

// add_label: Add a net label
server.tool(
  'add_label',
  'Add a net label at a point',
  {
    filePath: z.string().describe('Schematic file path'),
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    text: z.string().describe('Label text (net name)'),
    direction: z.number().optional().describe('0=vertical, 1=horizontal (default 1)'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x, y, text, direction, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const label: Label = { L: layer ?? 0, X: x, Y: y, D: direction ?? 1, S: text };
    sch.labels.push(label);

    return { content: [{ type: 'text' as const, text: `Label "${text}" added at (${x},${y}). Total: ${sch.labels.length}` }] };
  }
);

// add_tag: Add a tag
server.tool(
  'add_tag',
  'Add a tag (for inter-page connections)',
  {
    filePath: z.string().describe('Schematic file path'),
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    text: z.string().describe('Tag text'),
    direction: z.number().optional().describe('0=vertical, 1=horizontal (default 1)'),
    shape: z.number().optional().describe('0=rectangle, 1=left/up pointed, 2=right/down pointed, 3=both pointed'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x, y, text, direction, shape, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const tag: Tag = { L: layer ?? 0, X: x, Y: y, D: direction ?? 1, T: shape ?? 0, S: text };
    sch.tags.push(tag);

    return { content: [{ type: 'text' as const, text: `Tag "${text}" added at (${x},${y}). Total: ${sch.tags.length}` }] };
  }
);

// add_comment: Add a comment
server.tool(
  'add_comment',
  'Add a text comment to the schematic',
  {
    filePath: z.string().describe('Schematic file path'),
    x: z.number().describe('X coordinate'),
    y: z.number().describe('Y coordinate'),
    text: z.string().describe('Comment text'),
    width: z.number().optional().describe('Text width (-1 for auto)'),
    fontSize: z.number().optional().describe('Font size in pixels'),
    fontName: z.string().optional().describe('Font name'),
    fontFlags: z.string().optional().describe('Font flags: B=bold, I=italic'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x, y, text, width, fontSize, fontName, fontFlags, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const comment: Comment = {
      L: layer ?? 0, X: x, Y: y,
      W: width ?? -1,
      S: text,
      FN: fontName,
      FS: fontSize,
      FF: fontFlags,
    };
    sch.comments.push(comment);

    return { content: [{ type: 'text' as const, text: `Comment added at (${x},${y}). Total: ${sch.comments.length}` }] };
  }
);

// get_schematic_summary: Get a summary of the loaded schematic
server.tool(
  'get_schematic_summary',
  'Get a summary of the loaded schematic (element counts, component list)',
  { filePath: z.string().describe('Schematic file path') },
  async ({ filePath }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const summary = {
      sheetSize: `${sch.sheetInfo.W}x${sch.sheetInfo.H}`,
      counts: {
        components: sch.components.length,
        wires: sch.wires.length,
        buses: sch.buses.length,
        junctions: sch.junctions.length,
        labels: sch.labels.length,
        tags: sch.tags.length,
        comments: sch.comments.length,
        busEntries: sch.busEntries.length,
        entries: sch.entries.length,
        dashes: sch.dashes.length,
        markers: sch.markers.length,
        images: sch.images.length,
      },
      components: sch.components.map((c, i) => ({
        index: i,
        lib: c.props.LIB,
        name: c.props.N,
        refdes: c.props.R,
        position: { x: c.props.X, y: c.props.Y },
        dir: c.props.DIR,
      })),
    };

    return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
  }
);

// get_net_connections: Analyze net connections
server.tool(
  'get_net_connections',
  'Analyze the schematic and return net connections (which pins are connected together via wires, junctions, tags, labels, and power symbols)',
  { filePath: z.string().describe('Schematic file path') },
  async ({ filePath }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    try {
      const nets = generateNetlist(sch);
      const output = nets.map(net => ({
        netName: net.netName,
        pinCount: net.pins.length,
        pins: net.pins.map(p => ({
          refdes: p.refdes,
          pinNum: p.pinNum,
          pinName: p.pinName,
          component: p.componentName,
          position: { x: p.x, y: p.y },
        })),
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// set_sheet_size: Change sheet dimensions
server.tool(
  'set_sheet_size',
  'Change the sheet size of the schematic',
  {
    filePath: z.string().describe('Schematic file path'),
    width: z.number().optional().describe('New width in pixels'),
    height: z.number().optional().describe('New height in pixels'),
  },
  async ({ filePath, width, height }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const oldW = sch.sheetInfo.W;
    const oldH = sch.sheetInfo.H;
    if (width !== undefined) sch.sheetInfo.W = width;
    if (height !== undefined) sch.sheetInfo.H = height;

    return { content: [{ type: 'text' as const, text: `Sheet size changed from ${oldW}x${oldH} to ${sch.sheetInfo.W}x${sch.sheetInfo.H}` }] };
  }
);

// remove_component: Remove a component by index or matching criteria
server.tool(
  'remove_component',
  'Remove a component from the schematic by index, or by matching lib name and position. For power symbols (VCC, GND) which have no refdes, use lib+x+y to identify. Connected wires are NOT removed automatically.',
  {
    filePath: z.string().describe('Schematic file path'),
    index: z.number().optional().describe('Component index (from get_schematic_summary)'),
    lib: z.string().optional().describe('Library name to match (e.g. "NOCONNECTION")'),
    x: z.number().optional().describe('X position to match'),
    y: z.number().optional().describe('Y position to match'),
  },
  async ({ filePath, index, lib, x, y }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    if (index !== undefined) {
      if (index < 0 || index >= sch.components.length) {
        return { content: [{ type: 'text' as const, text: `Error: index ${index} out of range (0-${sch.components.length - 1})` }], isError: true };
      }
      const removed = sch.components.splice(index, 1)[0];
      return { content: [{ type: 'text' as const, text: `Removed component[${index}]: ${removed.props.LIB} "${removed.props.N}" ${removed.props.R} at (${removed.props.X},${removed.props.Y}). Remaining: ${sch.components.length}` }] };
    }

    if (lib !== undefined) {
      const before = sch.components.length;
      const removed: string[] = [];
      sch.components = sch.components.filter(c => {
        const match = c.props.LIB === lib &&
          (x === undefined || c.props.X === x) &&
          (y === undefined || c.props.Y === y);
        if (match) removed.push(`${c.props.LIB} "${c.props.N}" at (${c.props.X},${c.props.Y})`);
        return !match;
      });
      return { content: [{ type: 'text' as const, text: `Removed ${removed.length} component(s): ${removed.join('; ')}. Remaining: ${sch.components.length}` }] };
    }

    return { content: [{ type: 'text' as const, text: 'Error: specify either index or lib (with optional x,y) to identify component(s) to remove' }], isError: true };
  }
);

// move_component: Move a component to a new position
server.tool(
  'move_component',
  'Move a component to a new position. Specify by index (from get_schematic_summary) or refdes. Note: this only moves the component, not connected wires. You must update wires separately using remove_wire and add_wire.',
  {
    filePath: z.string().describe('Schematic file path'),
    index: z.number().optional().describe('Component index'),
    refdes: z.string().optional().describe('Reference designator (e.g. "R5", "D5")'),
    x: z.number().describe('New X coordinate (right-bottom of component)'),
    y: z.number().describe('New Y coordinate (right-bottom of component)'),
  },
  async ({ filePath, index, refdes, x, y }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    let comp: Component | undefined;
    let compIndex: number = -1;

    if (index !== undefined) {
      if (index < 0 || index >= sch.components.length) {
        return { content: [{ type: 'text' as const, text: `Error: index ${index} out of range (0-${sch.components.length - 1})` }], isError: true };
      }
      comp = sch.components[index];
      compIndex = index;
    } else if (refdes !== undefined) {
      compIndex = sch.components.findIndex(c => c.props.R === refdes);
      if (compIndex === -1) {
        return { content: [{ type: 'text' as const, text: `Error: no component with refdes "${refdes}" found` }], isError: true };
      }
      comp = sch.components[compIndex];
    } else {
      return { content: [{ type: 'text' as const, text: 'Error: specify either index or refdes' }], isError: true };
    }

    const oldX = comp.props.X;
    const oldY = comp.props.Y;
    comp.props.X = x;
    comp.props.Y = y;

    return { content: [{ type: 'text' as const, text: `Moved ${comp.props.LIB} "${comp.props.N}" ${comp.props.R} from (${oldX},${oldY}) to (${x},${y})` }] };
  }
);

// rotate_component: Rotate or mirror a component
server.tool(
  'rotate_component',
  'Rotate or mirror a component. Rotation is 90-degree clockwise steps. Mirror flips left-right. Name/refdes positions are reset to defaults after rotation.',
  {
    filePath: z.string().describe('Schematic file path'),
    index: z.number().optional().describe('Component index'),
    refdes: z.string().optional().describe('Reference designator'),
    rotate: z.number().optional().describe('Number of 90-degree clockwise rotations (1-3)'),
    mirror: z.boolean().optional().describe('Toggle left-right mirror'),
  },
  async ({ filePath, index, refdes, rotate, mirror }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    let comp: Component | undefined;
    if (index !== undefined) {
      if (index < 0 || index >= sch.components.length) {
        return { content: [{ type: 'text' as const, text: `Error: index ${index} out of range` }], isError: true };
      }
      comp = sch.components[index];
    } else if (refdes !== undefined) {
      comp = sch.components.find(c => c.props.R === refdes);
      if (!comp) return { content: [{ type: 'text' as const, text: `Error: no component with refdes "${refdes}"` }], isError: true };
    } else {
      return { content: [{ type: 'text' as const, text: 'Error: specify either index or refdes' }], isError: true };
    }

    const oldDir = comp.props.DIR;
    let dir = oldDir;

    // Apply rotation (matches BSch3V rotateDir logic)
    if (rotate) {
      for (let i = 0; i < rotate; i++) {
        dir &= 0x07;
        if (dir & 0x04) {
          dir = ((dir - 1) & 0x03) | 0x04;
        } else {
          dir = (dir + 1) & 0x03;
        }
      }
    }

    // Apply mirror (matches BSch3V mirrorDir logic)
    if (mirror) {
      dir &= 0x07;
      dir ^= 0x04;
    }

    comp.props.DIR = dir;

    // Reset name/refdes positions to defaults (BSch3V does this on rotate/mirror)
    comp.props.NX = 2;
    comp.props.NY = 20;
    comp.props.ND = 1;
    comp.props.RX = 2;
    comp.props.RY = 10;
    comp.props.RD = 1;

    const dirNames = ['0°', '90°', '180°', '270°', 'M0°', 'M90°', 'M180°', 'M270°'];
    return { content: [{ type: 'text' as const, text: `Rotated ${comp.props.LIB} "${comp.props.N}" ${comp.props.R}: DIR ${oldDir}(${dirNames[oldDir]}) → ${dir}(${dirNames[dir]})` }] };
  }
);

// set_component_properties: Change component properties
server.tool(
  'set_component_properties',
  'Change properties of a component (name, refdes, name/refdes position, direction, etc). Specify the component by index or refdes.',
  {
    filePath: z.string().describe('Schematic file path'),
    index: z.number().optional().describe('Component index'),
    refdes: z.string().optional().describe('Reference designator to find the component'),
    newName: z.string().optional().describe('New component name (N)'),
    newRefdes: z.string().optional().describe('New reference designator (R)'),
    dir: z.number().optional().describe('Direction (0-7)'),
    nx: z.number().optional().describe('Name X offset from component origin'),
    ny: z.number().optional().describe('Name Y offset from component origin'),
    nh: z.number().optional().describe('Hide name (1=hide, 0=show)'),
    nd: z.number().optional().describe('Name direction (1=horizontal, 0=vertical)'),
    rx: z.number().optional().describe('Refdes X offset from component origin'),
    ry: z.number().optional().describe('Refdes Y offset from component origin'),
    rh: z.number().optional().describe('Hide refdes (1=hide, 0=show)'),
    rd: z.number().optional().describe('Refdes direction (1=horizontal, 0=vertical)'),
    block: z.number().optional().describe('Block number'),
  },
  async ({ filePath, index, refdes, newName, newRefdes, dir, nx, ny, nh, nd, rx, ry, rh, rd, block }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    let comp: Component | undefined;
    if (index !== undefined) {
      if (index < 0 || index >= sch.components.length) {
        return { content: [{ type: 'text' as const, text: `Error: index ${index} out of range` }], isError: true };
      }
      comp = sch.components[index];
    } else if (refdes !== undefined) {
      comp = sch.components.find(c => c.props.R === refdes);
      if (!comp) {
        return { content: [{ type: 'text' as const, text: `Error: no component with refdes "${refdes}"` }], isError: true };
      }
    } else {
      return { content: [{ type: 'text' as const, text: 'Error: specify either index or refdes' }], isError: true };
    }

    const changes: string[] = [];
    if (newName !== undefined) { comp.props.N = newName; changes.push(`N=${newName}`); }
    if (newRefdes !== undefined) { comp.props.R = newRefdes; changes.push(`R=${newRefdes}`); }
    if (dir !== undefined) { comp.props.DIR = dir; changes.push(`DIR=${dir}`); }
    if (nx !== undefined) { comp.props.NX = nx; changes.push(`NX=${nx}`); }
    if (ny !== undefined) { comp.props.NY = ny; changes.push(`NY=${ny}`); }
    if (nh !== undefined) { comp.props.NH = nh; changes.push(`NH=${nh}`); }
    if (nd !== undefined) { comp.props.ND = nd; changes.push(`ND=${nd}`); }
    if (rx !== undefined) { comp.props.RX = rx; changes.push(`RX=${rx}`); }
    if (ry !== undefined) { comp.props.RY = ry; changes.push(`RY=${ry}`); }
    if (rh !== undefined) { comp.props.RH = rh; changes.push(`RH=${rh}`); }
    if (rd !== undefined) { comp.props.RD = rd; changes.push(`RD=${rd}`); }
    if (block !== undefined) { comp.props.BLK = block; changes.push(`BLK=${block}`); }

    if (changes.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No changes specified' }], isError: true };
    }

    return { content: [{ type: 'text' as const, text: `Updated ${comp.props.LIB} "${comp.props.N}" ${comp.props.R} at (${comp.props.X},${comp.props.Y}): ${changes.join(', ')}` }] };
  }
);

// remove_wire: Remove a wire by matching endpoints
server.tool(
  'remove_wire',
  'Remove wire(s) from the schematic by matching start and end coordinates',
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X'),
    y1: z.number().describe('Start Y'),
    x2: z.number().describe('End X'),
    y2: z.number().describe('End Y'),
  },
  async ({ filePath, x1, y1, x2, y2 }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const before = sch.wires.length;
    const removed: string[] = [];
    sch.wires = sch.wires.filter(w => {
      const match = (w.X1 === x1 && w.Y1 === y1 && w.X2 === x2 && w.Y2 === y2) ||
                    (w.X1 === x2 && w.Y1 === y2 && w.X2 === x1 && w.Y2 === y1);
      if (match) removed.push(`(${w.X1},${w.Y1})→(${w.X2},${w.Y2})`);
      return !match;
    });

    if (removed.length === 0) {
      return { content: [{ type: 'text' as const, text: `No wire found matching (${x1},${y1})→(${x2},${y2})` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: `Removed ${removed.length} wire(s): ${removed.join('; ')}. Remaining: ${sch.wires.length}` }] };
  }
);

// get_component_pins: Get pin positions for a component
server.tool(
  'get_component_pins',
  `Get the pin connection point coordinates of a component. Essential for wiring - call this before add_wire to know exact pin positions.
Pin positions account for component position, direction (rotation/mirror), and pin length (10px extension from body edge).`,
  {
    filePath: z.string().describe('Schematic file path'),
    index: z.number().optional().describe('Component index'),
    refdes: z.string().optional().describe('Reference designator'),
  },
  async ({ filePath, index, refdes }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    let comp: Component | undefined;
    if (index !== undefined) {
      if (index < 0 || index >= sch.components.length) {
        return { content: [{ type: 'text' as const, text: `Error: index ${index} out of range` }], isError: true };
      }
      comp = sch.components[index];
    } else if (refdes !== undefined) {
      comp = sch.components.find(c => c.props.R === refdes);
      if (!comp) return { content: [{ type: 'text' as const, text: `Error: no component with refdes "${refdes}"` }], isError: true };
    } else {
      return { content: [{ type: 'text' as const, text: 'Error: specify either index or refdes' }], isError: true };
    }

    const compData = comp.embeddedLib?.components?.[0];
    if (!compData) {
      return { content: [{ type: 'text' as const, text: 'Error: no embedded library data for this component' }], isError: true };
    }

    const block = comp.props.BLK;
    const pins = compData.pins.map(pin => {
      const pos = pinEnd(comp!, pin);
      return {
        name: pin.N,
        num: pin.M[block] ?? pin.M[0] ?? '',
        location: pin.L,
        type: pin.T,
        position: pos ? { x: pos.x, y: pos.y } : null,
      };
    });

    return { content: [{ type: 'text' as const, text: JSON.stringify({
      lib: comp.props.LIB,
      name: comp.props.N,
      refdes: comp.props.R,
      position: { x: comp.props.X, y: comp.props.Y },
      dir: comp.props.DIR,
      pins,
    }, null, 2) }] };
  }
);

// add_bus: Add a bus line
server.tool(
  'add_bus',
  'Add a bus line between two points',
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X'),
    y1: z.number().describe('Start Y'),
    x2: z.number().describe('End X'),
    y2: z.number().describe('End Y'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x1, y1, x2, y2, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const bus: Bus = { L: layer ?? 0, X1: x1, Y1: y1, X2: x2, Y2: y2 };
    sch.buses.push(bus);

    return { content: [{ type: 'text' as const, text: `Bus added (${x1},${y1})→(${x2},${y2}). Total buses: ${sch.buses.length}` }] };
  }
);

// add_bus_entry: Add a bus entry (angled line connecting wire to bus)
server.tool(
  'add_bus_entry',
  'Add a bus entry (diagonal line connecting a wire to a bus)',
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X (wire side)'),
    y1: z.number().describe('Start Y (wire side)'),
    x2: z.number().describe('End X (bus side)'),
    y2: z.number().describe('End Y (bus side)'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x1, y1, x2, y2, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const bentry: BusEntry = { L: layer ?? 0, X1: x1, Y1: y1, X2: x2, Y2: y2 };
    sch.busEntries.push(bentry);

    return { content: [{ type: 'text' as const, text: `Bus entry added (${x1},${y1})→(${x2},${y2}). Total: ${sch.busEntries.length}` }] };
  }
);

// add_entry: Add an entry (angled line for sheet connections)
server.tool(
  'add_entry',
  'Add an entry line',
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X'),
    y1: z.number().describe('Start Y'),
    x2: z.number().describe('End X'),
    y2: z.number().describe('End Y'),
    layer: z.number().optional().describe('Layer (default 0)'),
  },
  async ({ filePath, x1, y1, x2, y2, layer }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const entry: Entry = { L: layer ?? 0, X1: x1, Y1: y1, X2: x2, Y2: y2 };
    sch.entries.push(entry);

    return { content: [{ type: 'text' as const, text: `Entry added (${x1},${y1})→(${x2},${y2}). Total: ${sch.entries.length}` }] };
  }
);

// add_dash: Add a decorative line (solid, dashed, dot-dash, etc.)
server.tool(
  'add_dash',
  'Add a decorative line with style options (solid, dashed, dot-dash, etc.) and optional arrowheads',
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X'),
    y1: z.number().describe('Start Y'),
    x2: z.number().describe('End X'),
    y2: z.number().describe('End Y'),
    layer: z.number().optional().describe('Layer (default 0)'),
    lineStyle: z.string().optional().describe('Line style: NORM(solid), DASH(dashed), LDT(dot-dash), LDDT(two-dot-dash). Default: NORM'),
    width: z.number().optional().describe('Line width (default 1)'),
    startStyle: z.string().optional().describe('Start point style: NORM(plain), ARRW(arrow), CRCL(circle)'),
    endStyle: z.string().optional().describe('End point style: NORM(plain), ARRW(arrow), CRCL(circle)'),
    endMarkerSize: z.number().optional().describe('End marker size'),
  },
  async ({ filePath, x1, y1, x2, y2, layer, lineStyle, width, startStyle, endStyle, endMarkerSize }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const dash: Dash = {
      L: layer ?? 0, X1: x1, Y1: y1, X2: x2, Y2: y2,
      WDT: width,
      LS: lineStyle,
      SSTL: startStyle,
      ESTL: endStyle,
      EMS: endMarkerSize,
    };
    sch.dashes.push(dash);

    return { content: [{ type: 'text' as const, text: `Dash line added (${x1},${y1})→(${x2},${y2}) style:${lineStyle ?? 'NORM'}. Total: ${sch.dashes.length}` }] };
  }
);

// add_marker: Add a colored marker line
server.tool(
  'add_marker',
  'Add a colored marker line (for annotations)',
  {
    filePath: z.string().describe('Schematic file path'),
    x1: z.number().describe('Start X'),
    y1: z.number().describe('Start Y'),
    x2: z.number().describe('End X'),
    y2: z.number().describe('End Y'),
    layer: z.number().optional().describe('Layer (default 0)'),
    width: z.number().optional().describe('Line width (default 1)'),
    color: z.number().optional().describe('Color as BGR 24-bit integer (e.g. 255=blue, 65280=green, 16711680=red). Default: 255 (blue)'),
  },
  async ({ filePath, x1, y1, x2, y2, layer, width, color }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const marker: Marker = {
      L: layer ?? 0, X1: x1, Y1: y1, X2: x2, Y2: y2,
      STL: 0,
      WDT: width ?? 1,
      CLR: color ?? 255,
    };
    sch.markers.push(marker);

    return { content: [{ type: 'text' as const, text: `Marker added (${x1},${y1})→(${x2},${y2}) color:${color ?? 255}. Total: ${sch.markers.length}` }] };
  }
);

// set_visible_layers: Set layer visibility
server.tool(
  'set_visible_layers',
  'Set which layers are visible. VL is a bitmask where bit 0=layer 0, bit 7=layer 7. Value 255 = all visible.',
  {
    filePath: z.string().describe('Schematic file path'),
    visibleLayers: z.number().describe('Visible layers bitmask (0-255). 255=all visible, 1=only layer 0, etc.'),
  },
  async ({ filePath, visibleLayers }) => {
    const result = getSchematic(filePath);
    if ('error' in result) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
    const { sch } = result;

    const oldVL = sch.sheetInfo.VL;
    sch.sheetInfo.VL = visibleLayers & 0xFF;

    return { content: [{ type: 'text' as const, text: `Visible layers changed from ${oldVL} (0b${oldVL.toString(2).padStart(8,'0')}) to ${sch.sheetInfo.VL} (0b${sch.sheetInfo.VL.toString(2).padStart(8,'0')})` }] };
  }
);

// modify_library_component: Modify an existing component's properties and return as embeddedLibJson
server.tool(
  'modify_library_component',
  `Get an existing component and modify its name, ref prefix, and/or pin definitions. Useful for creating variants of existing components.
Use this when a similar symbol already exists in the library (e.g. changing pin numbers on a diode, or renaming pins on a connector).
IMPORTANT: For 2-terminal components (diodes, resistors, capacitors, etc.), pin names are normally empty strings. Only change pin numbers (num), not names. Setting pin names will display them on the symbol, which is usually undesirable for discrete components.
Example for diode: pinChanges: '{"1":{"num":"A"}, "2":{"num":"K"}}' (changes numbers only, keeps names empty)
Example for IC: pinChanges: '{"1":{"name":"RESET","num":"1"}}' (IC pins typically have visible names)`,
  {
    componentName: z.string().describe('Source component name to copy from (e.g. "SCHOTTKY-D", "NPN")'),
    filePath: z.string().optional().describe('LB3 file path. If omitted, searches all libraries'),
    schematicPath: z.string().optional().describe('CE3 file to search'),
    newName: z.string().optional().describe('New component name. If omitted, keeps original'),
    newRefPrefix: z.string().optional().describe('New reference prefix (e.g. "D", "Q"). If omitted, keeps original'),
    pinChanges: z.string().optional().describe('JSON object mapping pin number to new values: {"1":{"name":"A","num":"1"}, "2":{"name":"K","num":"2"}}. Keys are original pin numbers.'),
  },
  async ({ componentName, filePath, schematicPath, newName, newRefPrefix, pinChanges }) => {
    try {
      // 1. Find the source component
      let embeddedLib: unknown = null;

      if (schematicPath) {
        const text = readSchematicFile(schematicPath);
        const sch = parseSchematic(text);
        const comp = sch.components.find(c => c.props.LIB === componentName && c.embeddedLib);
        if (comp) embeddedLib = JSON.parse(JSON.stringify(comp.embeddedLib));
      }

      if (!embeddedLib) {
        let libFiles: string[];
        if (filePath) {
          libFiles = [filePath];
        } else {
          const autoIni = getIniPath();
          if (autoIni) {
            libFiles = parseIniLibraries(autoIni);
          } else {
            return { content: [{ type: 'text' as const, text: 'Error: component source not found' }], isError: true };
          }
        }

        for (const lf of libFiles) {
          const text = readSchematicFile(lf);
          const lib = parseLibrary(text);
          const comp = lib.components.find(c => c.N === componentName);
          if (comp) {
            const patterns = comp.P ? lib.patterns.filter(p => p.N === comp.P) : [];
            embeddedLib = { VER: lib.VER, patterns, components: [JSON.parse(JSON.stringify(comp))] };
            break;
          }
        }
      }

      if (!embeddedLib) {
        return { content: [{ type: 'text' as const, text: `Error: component "${componentName}" not found` }], isError: true };
      }

      const lib = embeddedLib as { VER?: number; patterns: unknown[]; components: { N: string; R: string; pins: { N: string; M: string[] }[] }[] };
      const comp = lib.components[0];

      // 2. Apply modifications
      if (newName) comp.N = newName;
      if (newRefPrefix) comp.R = newRefPrefix;

      if (pinChanges) {
        const changes: Record<string, { name?: string; num?: string }> = JSON.parse(pinChanges);
        for (const pin of comp.pins) {
          const origNum = pin.M[0];
          if (changes[origNum]) {
            if (changes[origNum].name !== undefined) pin.N = changes[origNum].name!;
            if (changes[origNum].num !== undefined) pin.M = [changes[origNum].num!];
          }
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(lib) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// create_component: Create a new component definition from pin specifications
server.tool(
  'create_component',
  `Create a new rectangular IC component from pin specifications. Returns embeddedLibJson for add_component.
BEFORE CREATING A NEW COMPONENT, follow this workflow:
1. First search existing libraries: get_library_component(componentName)
2. If not found, ask the user if the component exists in another CE3 file they can provide
3. If a similar symbol exists (e.g. same package), use modify_library_component instead
4. Only if none of the above work, ask the user for permission to create a new component
5. If the component needs a graphical symbol (diode, transistor, etc.) that cannot be derived from existing libraries, ask the user to create it manually in LCoV.exe
This tool creates rectangular IC symbols only. For graphical symbols, use modify_library_component.
Pins JSON array: [{"name":"VCC","num":"1","side":"L","offset":1}, ...]
- side: L=left, R=right, T=top, B=bottom
- offset: grid position from top-left corner (1-based)
- name: pin name displayed on symbol (use "" for discrete components)
Width auto-calculated from pin name lengths. Minimum 4 grids.`,
  {
    name: z.string().describe('Component name (e.g. "ATmega328P")'),
    refPrefix: z.string().optional().describe('Reference designator prefix (e.g. "U", "IC"). Default: "U"'),
    pins: z.string().describe('JSON array of pin definitions: [{"name":"pin_name","num":"pin_number","side":"L/R/T/B","offset":grid_offset}, ...]'),
    width: z.number().optional().describe('Component width in grids. If omitted, auto-calculated'),
    height: z.number().optional().describe('Component height in grids. If omitted, auto-calculated'),
  },
  async ({ name, refPrefix, pins: pinsJson, width, height }) => {
    try {
      const pinDefs: { name: string; num: string; side: string; offset: number; type?: string }[] = JSON.parse(pinsJson);

      if (!Array.isArray(pinDefs) || pinDefs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: pins must be a non-empty JSON array' }], isError: true };
      }

      // Auto-calculate size from pin positions and pin name lengths
      let maxL = 0, maxR = 0, maxT = 0, maxB = 0;
      let maxLNameLen = 0, maxRNameLen = 0;
      for (const p of pinDefs) {
        const s = p.side.toUpperCase();
        const o = p.offset;
        if (s === 'L') { maxL = Math.max(maxL, o); maxLNameLen = Math.max(maxLNameLen, p.name.length); }
        else if (s === 'R') { maxR = Math.max(maxR, o); maxRNameLen = Math.max(maxRNameLen, p.name.length); }
        else if (s === 'T') maxT = Math.max(maxT, o);
        else if (s === 'B') maxB = Math.max(maxB, o);
      }

      const h = height ?? Math.max(maxL, maxR) + 1;
      // Width: ensure pin names fit. Each character ~8px, plus margins.
      // Minimum width = (left pin name + right pin name + spacing) / 10 grids
      const autoW = Math.max(
        maxT, maxB,
        Math.ceil((maxLNameLen + maxRNameLen + 2) * 8 / 10),  // pin names fit
        4  // minimum 4 grids
      ) + 1;
      const w = width ?? autoW;

      // Generate pattern: rectangle outline + pin position markers
      const ptnW = w * 10 + 1;
      const ptnH = h * 10 + 1;
      const elements: unknown[] = [];

      // Rectangle outline
      elements.push({
        type: 'PG', W: 1, S: 0, F: -1, N: 4,
        points: [
          { X: 0, Y: 0 }, { X: ptnW - 1, Y: 0 },
          { X: ptnW - 1, Y: ptnH - 1 }, { X: 0, Y: ptnH - 1 },
        ],
      });

      // Build pin definitions
      const compPins = pinDefs.map(p => ({
        N: p.name,
        L: `${p.side.toUpperCase()}${p.offset}`,
        T: p.type ?? 'S',
        DF: 'FFFFFFFF',
        M: [p.num],
      }));

      const embeddedLib = {
        VER: 81,
        patterns: [{
          N: name,
          X: ptnW,
          Y: ptnH,
          elements,
        }],
        components: [{
          N: name,
          X: w,
          Y: h,
          B: 1,
          R: refPrefix ?? 'U',
          P: name,
          pins: compPins,
          NOTE: '',
          MFR: '',
          MFRPN: '',
          PKG: '',
        }],
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(embeddedLib) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
    }
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
