// BSch3V CE3/LB3 data types

export interface SheetInfo {
  EL: number;
  VL: number;
  W: number;
  H: number;
  PROJ: string;
  PAGES: number;
  PAGE: number;
  VER: number;
  INITPOS: number;
}

export interface ComponentProps {
  L: number;
  X: number;
  Y: number;
  LIB: string;
  DIR: number;
  BLK: number;
  N: string;
  ND: number;
  NX: number;
  NY: number;
  NH: number;
  R: string;
  RD: number;
  RX: number;
  RY: number;
  RH: number;
  NOTE: string;
  PKG: string;
  MFR: string;
  MFRPN: string;
}

export interface EmbeddedLibrary {
  VER?: number;
  patterns: PatternBlock[];
  components: CompBlock[];
}

export interface Component {
  props: ComponentProps;
  embeddedLib?: EmbeddedLibrary;
}

export interface Wire {
  L: number;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
}

export interface Bus {
  L: number;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
}

export interface Dash {
  L: number;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
  CURV?: number;
  CTX1?: number;
  CTY1?: number;
  CTX2?: number;
  CTY2?: number;
  WDT?: number;
  LS?: string;
  SSTL?: string;
  ESTL?: string;
  EMS?: number;
}

export interface Marker {
  L: number;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
  STL: number;
  WDT: number;
  CLR: number;
}

export interface Junction {
  L: number;
  X: number;
  Y: number;
}

export interface BusEntry {
  L: number;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
}

export interface Entry {
  L: number;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
}

export interface Tag {
  L: number;
  X: number;
  Y: number;
  D: number;
  T: number;
  S: string;
}

export interface Label {
  L: number;
  X: number;
  Y: number;
  D: number;
  S: string;
}

export interface Comment {
  L: number;
  X: number;
  Y: number;
  W: number;
  S: string;
  FN?: string;
  TAG?: number;
  FS?: number;
  FF?: string;
}

export interface ImageObject {
  L: number;
  X: number;
  Y: number;
  MAG?: number;
  IMAGE_DIB?: string;
}

export interface Schematic {
  sheetInfo: SheetInfo;
  components: Component[];
  wires: Wire[];
  buses: Bus[];
  dashes: Dash[];
  markers: Marker[];
  junctions: Junction[];
  busEntries: BusEntry[];
  entries: Entry[];
  tags: Tag[];
  labels: Label[];
  comments: Comment[];
  images: ImageObject[];
}

// Library types

export interface LineElement {
  type: 'L';
  W: number;
  S: number;
  points: { X: number; Y: number }[];
}

export interface ArcElement {
  type: 'AR';
  W: number;
  S: number;
  X: number;
  Y: number;
  R: number;
  B: number;
  E: number;
}

export interface PolygonElement {
  type: 'PG';
  W: number;
  S: number;
  F: number;
  N: number;
  points: { X: number; Y: number }[];
}

export interface CircleElement {
  type: 'C';
  W: number;
  S: number;
  F: number;
  points: { X: number; Y: number }[];
}

export interface TextElement {
  type: 'TX';
  X: number;
  Y: number;
  A: number;
  D: number;
  S: string;
  FN?: string;
  FS?: number;
  FF?: string;
}

export interface BmpBlock {
  type: 'BMP';
  data: string;
}

export type PatternElement = LineElement | ArcElement | PolygonElement | CircleElement | TextElement | BmpBlock;

export interface PatternBlock {
  N: string;
  X: number;
  Y: number;
  elements: PatternElement[];
}

export interface Pin {
  N: string;
  L: string;
  T: string;
  M: string[];
  DF?: string;
}

export interface CompBlock {
  N: string;
  X: number;
  Y: number;
  B: number;
  R: string;
  P?: string;
  pins: Pin[];
  NOTE?: string;
  MFR?: string;
  MFRPN?: string;
  PKG?: string;
}

export interface Library {
  VER?: number;
  PROP?: string;
  patterns: PatternBlock[];
  components: CompBlock[];
}
