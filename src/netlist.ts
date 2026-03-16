// Net list generation - port of NL3W logic

import type { Schematic, Component, Wire, Junction, Label, Tag, Pin } from './types.js';

const PIN_LENGTH = 10;
const GRID = 10;

interface PinPosition {
  x: number;
  y: number;
  refdes: string;
  pinNum: string;
  pinName: string;
  componentName: string;
  libName: string;
}

interface NetConnection {
  netName: string;
  pins: PinPosition[];
}

// Compute the size of a component in pixels, considering DIR rotation
export function componentSizePixels(comp: Component): { w: number; h: number } {
  const compData = comp.embeddedLib?.components?.[0];
  let w = compData ? compData.X * GRID : 20;
  let h = compData ? compData.Y * GRID : 20;
  if (comp.props.DIR & 1) {
    // Swap w and h for 90/270 degree rotation
    const tmp = w; w = h; h = tmp;
  }
  return { w, h };
}

// Compute pin location (at component body edge) considering DIR
function pinLoc(comp: Component, pin: Pin): { x: number; y: number; ltrb: number } | null {
  const loc = pin.L;
  if (!loc || loc.length < 2) return null;

  const sideChar = loc[0]; // L, T, R, B
  const offset = parseInt(loc.substring(1), 10) * GRID;

  let baseLtrb: number;
  switch (sideChar) {
    case 'L': baseLtrb = 0; break;
    case 'T': baseLtrb = 1; break;
    case 'R': baseLtrb = 2; break;
    case 'B': baseLtrb = 3; break;
    default: return null;
  }

  const dir = comp.props.DIR;

  // Apply rotation: nLtrb = (baseLtrb + (dir & 3)) & 3
  let nLtrb = (baseLtrb + (dir & 3)) & 3;

  // Apply mirror (bit 2 of dir): swap L and R
  if (dir & 4) {
    if (nLtrb === 0) nLtrb = 2;
    else if (nLtrb === 2) nLtrb = 0;
  }

  const { w, h } = componentSizePixels(comp);
  const x = comp.props.X; // right-bottom X
  const y = comp.props.Y; // right-bottom Y

  let px: number, py: number;

  switch (nLtrb) {
    case 0: // L
      px = x - w;
      if (dir === 2 || dir === 3 || dir === 6 || dir === 7) {
        py = y - offset;
      } else {
        py = y - h + offset;
      }
      break;
    case 1: // T
      py = y - h;
      if (dir === 1 || dir === 2 || dir === 4 || dir === 7) {
        px = x - offset;
      } else {
        px = x - w + offset;
      }
      break;
    case 2: // R
      px = x;
      if (dir === 2 || dir === 3 || dir === 6 || dir === 7) {
        py = y - offset;
      } else {
        py = y - h + offset;
      }
      break;
    case 3: // B
      py = y;
      if (dir === 1 || dir === 2 || dir === 4 || dir === 7) {
        px = x - offset;
      } else {
        px = x - w + offset;
      }
      break;
    default:
      return null;
  }

  return { x: px!, y: py!, ltrb: nLtrb };
}

// Compute pin end position (tip of pin, where wires connect)
export function pinEnd(comp: Component, pin: Pin): { x: number; y: number; ltrb: number } | null {
  const loc = pinLoc(comp, pin);
  if (!loc) return null;

  // Check for zero-length pin
  const pinType = parsePinType(pin.T);
  if (pinType & 0x02) { // PIN_TYPE_ZLENG
    return loc;
  }

  switch (loc.ltrb) {
    case 0: loc.x -= PIN_LENGTH; break; // L
    case 1: loc.y -= PIN_LENGTH; break; // T
    case 2: loc.x += PIN_LENGTH; break; // R
    case 3: loc.y += PIN_LENGTH; break; // B
  }
  return loc;
}

function parsePinType(t: string): number {
  let type = 0;
  if (t.includes('S')) type |= 0x01; // PIN_TYPE_SMALL
  if (t.includes('Z')) type |= 0x02; // PIN_TYPE_ZLENG
  if (t.includes('C')) type |= 0x04; // PIN_TYPE_CLOCK
  if (t.includes('N')) type |= 0x08; // PIN_TYPE_NEGATIVE
  if (t.includes('m')) type |= 0x10; // PIN_TYPE_NUMHIDE
  return type;
}

// Wire segment with signal names
interface WireSegment {
  x1: number; y1: number;
  x2: number; y2: number;
  signalNames: string[];
}

// Calculate tag width (from BSch3V source)
function tagWidth(text: string): number {
  const narrayTagWidth = [20, 20, 30, 40, 50, 60, 70, 80, 80, 90, 100, 110, 120];
  const l = text.length;
  if (l <= 12) return narrayTagWidth[l];
  return Math.floor((l * 8 + 29) / 10) * 10;
}

// Get tag pin positions (p1 and p2)
function tagPinPositions(tag: Tag): { x: number; y: number }[] {
  const p1 = { x: tag.X, y: tag.Y };
  const w = tagWidth(tag.S);
  let p2: { x: number; y: number };
  if (tag.D === 1) { // horizontal
    p2 = { x: tag.X + w, y: tag.Y };
  } else { // vertical
    p2 = { x: tag.X, y: tag.Y - w };
  }
  return [p1, p2];
}

// Point key for Map lookup
function ptKey(x: number, y: number): string {
  return `${x},${y}`;
}

// Check if point is on a wire segment (horizontal or vertical only)
function pointOnWire(px: number, py: number, w: WireSegment): boolean {
  if (w.y1 === w.y2 && py === w.y1) {
    // Horizontal wire
    const minX = Math.min(w.x1, w.x2);
    const maxX = Math.max(w.x1, w.x2);
    return px >= minX && px <= maxX;
  }
  if (w.x1 === w.x2 && px === w.x1) {
    // Vertical wire
    const minY = Math.min(w.y1, w.y2);
    const maxY = Math.max(w.y1, w.y2);
    return py >= minY && py <= maxY;
  }
  return false;
}

export function generateNetlist(sch: Schematic): NetConnection[] {
  // Step 1: Enumerate pin positions
  const allPins: PinPosition[] = [];
  const powerPins: PinPosition[] = []; // 1-pin components without refdes (power symbols)

  for (const comp of sch.components) {
    const compData = comp.embeddedLib?.components?.[0];
    if (!compData) continue;

    const block = comp.props.BLK;

    for (const pin of compData.pins) {
      const pos = pinEnd(comp, pin);
      if (!pos) continue;

      const pinNum = pin.M[block] ?? pin.M[0] ?? '';
      const pinPos: PinPosition = {
        x: pos.x,
        y: pos.y,
        refdes: comp.props.R,
        pinNum,
        pinName: pin.N,
        componentName: comp.props.N,
        libName: comp.props.LIB,
      };

      if (comp.props.R === '' && compData.pins.length === 1) {
        // Power symbol (VCC, GND, etc) - treated as tag/power
        powerPins.push(pinPos);
      } else if (comp.props.R !== '') {
        allPins.push(pinPos);
      }
    }
  }

  // Step 2: Create wire segments
  const wires: WireSegment[] = sch.wires.map(w => ({
    x1: w.X1, y1: w.Y1, x2: w.X2, y2: w.Y2,
    signalNames: [],
  }));

  // Step 3: Join collinear wires
  joinWires(wires);

  // Step 4: Divide wires at junctions
  for (const j of sch.junctions) {
    divideWiresAtPoint(wires, j.X, j.Y);
  }

  // Step 5: Name from tags and power symbols
  for (const tag of sch.tags) {
    const signalName = tag.S.trim();
    if (!signalName) continue;
    const tagPoints = tagPinPositions(tag);

    // Tag connects at both p1 and p2 - check wire endpoints
    for (const tp of tagPoints) {
      for (const w of wires) {
        if ((w.x1 === tp.x && w.y1 === tp.y) ||
            (w.x2 === tp.x && w.y2 === tp.y)) {
          w.signalNames.push(signalName);
        }
      }
    }
  }

  for (const pp of powerPins) {
    const signalName = pp.componentName.trim() || pp.libName.trim();
    if (!signalName) continue;

    for (const w of wires) {
      if ((w.x1 === pp.x && w.y1 === pp.y) ||
          (w.x2 === pp.x && w.y2 === pp.y)) {
        w.signalNames.push(signalName);
      }
    }
    // Also check if power pin directly touches a component pin
    for (const pin of allPins) {
      if (pin.x === pp.x && pin.y === pp.y) {
        // Direct connection handled via net building
      }
    }
  }

  // Step 6: Name from labels
  for (const label of sch.labels) {
    const signalName = label.S.trim();
    if (!signalName) continue;
    const lx = label.X, ly = label.Y;
    const horizontal = label.D === 1;

    for (const w of wires) {
      if (horizontal) {
        if (ly === w.y1 && w.y1 === w.y2) {
          const minX = Math.min(w.x1, w.x2);
          const maxX = Math.max(w.x1, w.x2);
          if (lx >= minX && lx <= maxX) {
            w.signalNames.push(signalName);
          }
        }
      } else {
        if (lx === w.x1 && w.x1 === w.x2) {
          const minY = Math.min(w.y1, w.y2);
          const maxY = Math.max(w.y1, w.y2);
          if (ly >= minY && ly <= maxY) {
            w.signalNames.push(signalName);
          }
        }
      }
    }
  }

  // Step 7: Build nets using Union-Find
  // Each pin and each wire endpoint is a node
  // Connect: pin to wire endpoint if they share coordinates
  // Connect: wire endpoints of same wire
  // Connect: all points sharing a junction coordinate

  const nodeMap = new Map<string, number>(); // ptKey -> node id
  let nodeCount = 0;

  function getNode(x: number, y: number): number {
    const key = ptKey(x, y);
    let id = nodeMap.get(key);
    if (id === undefined) {
      id = nodeCount++;
      nodeMap.set(key, id);
    }
    return id;
  }

  // Union-Find
  const parent: number[] = [];
  const rank: number[] = [];

  function makeSet(n: number) {
    while (parent.length <= n) {
      parent.push(parent.length);
      rank.push(0);
    }
  }

  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }

  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  }

  // Register all pin positions
  for (const pin of allPins) {
    const id = getNode(pin.x, pin.y);
    makeSet(id);
  }
  for (const pp of powerPins) {
    const id = getNode(pp.x, pp.y);
    makeSet(id);
  }

  // Register and connect wire endpoints
  for (const w of wires) {
    const id1 = getNode(w.x1, w.y1);
    const id2 = getNode(w.x2, w.y2);
    makeSet(id1);
    makeSet(id2);
    union(id1, id2);
  }

  // Connect tags at both pin positions (p1 and p2)
  for (const tag of sch.tags) {
    const tagPoints = tagPinPositions(tag);
    const ids = tagPoints.map(tp => {
      const id = getNode(tp.x, tp.y);
      makeSet(id);
      return id;
    });
    // Connect p1 and p2 of the same tag
    if (ids.length === 2) union(ids[0], ids[1]);
  }

  // Connect junctions - all nodes at junction coordinate are already connected via wire division
  for (const j of sch.junctions) {
    const id = getNode(j.X, j.Y);
    makeSet(id);
  }

  // Step 8: Collect nets
  const netGroups = new Map<number, {
    pins: PinPosition[];
    signalNames: Set<string>;
  }>();

  // Add component pins to nets
  for (const pin of allPins) {
    const root = find(getNode(pin.x, pin.y));
    let group = netGroups.get(root);
    if (!group) {
      group = { pins: [], signalNames: new Set() };
      netGroups.set(root, group);
    }
    group.pins.push(pin);
  }

  // Add signal names from wires
  for (const w of wires) {
    const root = find(getNode(w.x1, w.y1));
    let group = netGroups.get(root);
    if (!group) {
      group = { pins: [], signalNames: new Set() };
      netGroups.set(root, group);
    }
    for (const name of w.signalNames) {
      group.signalNames.add(name);
    }
  }

  // Add power symbol names
  for (const pp of powerPins) {
    const root = find(getNode(pp.x, pp.y));
    let group = netGroups.get(root);
    if (!group) {
      group = { pins: [], signalNames: new Set() };
      netGroups.set(root, group);
    }
    const sigName = pp.componentName.trim() || pp.libName.trim();
    if (sigName) group.signalNames.add(sigName);
  }

  // Add tag names (use p1 position, which is connected to p2 via union)
  for (const tag of sch.tags) {
    const sigName = tag.S.trim();
    if (!sigName) continue;
    const root = find(getNode(tag.X, tag.Y));
    let group = netGroups.get(root);
    if (!group) {
      group = { pins: [], signalNames: new Set() };
      netGroups.set(root, group);
    }
    group.signalNames.add(sigName);
  }

  // Add label names
  for (const label of sch.labels) {
    const sigName = label.S.trim();
    if (!sigName) continue;
    // Labels connect to wires they're on
    for (const w of wires) {
      if (pointOnWire(label.X, label.Y, w)) {
        const root = find(getNode(w.x1, w.y1));
        let group = netGroups.get(root);
        if (!group) {
          group = { pins: [], signalNames: new Set() };
          netGroups.set(root, group);
        }
        group.signalNames.add(sigName);
      }
    }
  }

  // Merge nets with the same signal name (tags connect across the schematic)
  const nameToRoot = new Map<string, number>();
  for (const [root, group] of netGroups) {
    for (const name of group.signalNames) {
      const existing = nameToRoot.get(name);
      if (existing !== undefined && existing !== root) {
        union(existing, root);
      } else {
        nameToRoot.set(name, root);
      }
    }
  }

  // Re-collect after merging
  const finalNets = new Map<number, {
    pins: PinPosition[];
    signalNames: Set<string>;
  }>();

  for (const [, group] of netGroups) {
    // Find new root for any pin in this group
    if (group.pins.length === 0 && group.signalNames.size === 0) continue;
    const sampleNode = group.pins.length > 0
      ? getNode(group.pins[0].x, group.pins[0].y)
      : nodeMap.values().next().value;
    const root = find(sampleNode!);
    let final = finalNets.get(root);
    if (!final) {
      final = { pins: [], signalNames: new Set() };
      finalNets.set(root, final);
    }
    for (const p of group.pins) final.pins.push(p);
    for (const n of group.signalNames) final.signalNames.add(n);
  }

  // Build result
  const result: NetConnection[] = [];
  let unnamedCounter = 0;

  for (const [, group] of finalNets) {
    if (group.pins.length === 0) continue; // Skip nets with no component pins
    const names = Array.from(group.signalNames);
    let netName: string;
    if (names.length > 0) {
      // Prefer NOCONNECTION if present
      if (names.includes('NOCONNECTION')) {
        netName = 'NOCONNECTION';
      } else {
        netName = names[0];
      }
    } else {
      netName = `NET_${++unnamedCounter}`;
    }

    result.push({
      netName,
      pins: group.pins,
    });
  }

  // Sort by net name
  result.sort((a, b) => a.netName.localeCompare(b.netName));

  return result;
}

// Join collinear wire segments
function joinWires(wires: WireSegment[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < wires.length; i++) {
      const a = wires[i];
      for (let j = i + 1; j < wires.length; j++) {
        const b = wires[j];
        // Both horizontal
        if (a.y1 === a.y2 && b.y1 === b.y2 && a.y1 === b.y1) {
          let al = Math.min(a.x1, a.x2);
          let ar = Math.max(a.x1, a.x2);
          const bl = Math.min(b.x1, b.x2);
          const br = Math.max(b.x1, b.x2);
          if (ar >= bl && br >= al) { // overlapping or touching
            al = Math.min(al, bl);
            ar = Math.max(ar, br);
            a.x1 = al; a.x2 = ar;
            a.signalNames.push(...b.signalNames);
            wires.splice(j, 1);
            changed = true;
            break;
          }
        }
        // Both vertical
        if (a.x1 === a.x2 && b.x1 === b.x2 && a.x1 === b.x1) {
          let at = Math.min(a.y1, a.y2);
          let ab = Math.max(a.y1, a.y2);
          const bt = Math.min(b.y1, b.y2);
          const bb = Math.max(b.y1, b.y2);
          if (ab >= bt && bb >= at) {
            at = Math.min(at, bt);
            ab = Math.max(ab, bb);
            a.y1 = at; a.y2 = ab;
            a.signalNames.push(...b.signalNames);
            wires.splice(j, 1);
            changed = true;
            break;
          }
        }
      }
    }
  }
}

// Divide wire segments at a junction point
function divideWiresAtPoint(wires: WireSegment[], jx: number, jy: number): void {
  for (let i = 0; i < wires.length; i++) {
    const w = wires[i];
    // Check if junction is strictly inside the wire (not at endpoints)
    if (w.y1 === w.y2 && jy === w.y1) {
      // Horizontal wire
      const minX = Math.min(w.x1, w.x2);
      const maxX = Math.max(w.x1, w.x2);
      if (jx > minX && jx < maxX) {
        // Split into two segments
        const newWire: WireSegment = {
          x1: jx, y1: jy, x2: maxX, y2: jy,
          signalNames: [...w.signalNames],
        };
        w.x1 = minX; w.x2 = jx;
        wires.push(newWire);
      }
    } else if (w.x1 === w.x2 && jx === w.x1) {
      // Vertical wire
      const minY = Math.min(w.y1, w.y2);
      const maxY = Math.max(w.y1, w.y2);
      if (jy > minY && jy < maxY) {
        const newWire: WireSegment = {
          x1: jx, y1: jy, x2: jx, y2: maxY,
          signalNames: [...w.signalNames],
        };
        w.y1 = minY; w.y2 = jy;
        wires.push(newWire);
      }
    }
  }
}
