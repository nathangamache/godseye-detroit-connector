/**
 * Minimal GTFS-Realtime (protobuf) decoder: just the FeedMessage fields transit_vehicles_near
 * uses (vehicle positions, trip-update delays and headsigns, service alerts), no dependency.
 * Field numbers follow gtfs-realtime.proto; unknown fields are skipped by wire type, every
 * length is bounds-checked and the entity count is capped, so a hostile feed can only fail.
 */

export class ProtobufError extends Error {}

class Reader {
  pos: number;
  /** Low 32 bits of the last varint (exact even when the full value is not). */
  lo = 0;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let value = 0;
    let lo = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtobufError('truncated varint');
      const b = this.buf[this.pos++]!;
      if (i < 5) lo = (lo | ((b & 0x7f) << (7 * i))) >>> 0;
      value += (b & 0x7f) * mul;
      mul *= 128;
      if (b < 0x80) {
        this.lo = lo;
        return value;
      }
    }
    throw new ProtobufError('varint too long');
  }

  /** int32 fields (negative values are sign-extended to 10 bytes on the wire). */
  int32(): number {
    this.varint();
    return this.lo | 0;
  }

  bytes(): Reader {
    const n = this.varint();
    if (n > this.end - this.pos) throw new ProtobufError('length past end');
    const r = new Reader(this.buf, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }

  string(): string {
    const r = this.bytes();
    return Buffer.from(r.buf.buffer, r.buf.byteOffset + r.pos, r.end - r.pos).toString('utf8');
  }

  float(): number {
    if (this.end - this.pos < 4) throw new ProtobufError('truncated fixed32');
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    if (this.end - this.pos < 8) throw new ProtobufError('truncated fixed64');
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        if (this.end - this.pos < 8) throw new ProtobufError('truncated fixed64');
        this.pos += 8;
        return;
      case 2:
        this.bytes();
        return;
      case 5:
        if (this.end - this.pos < 4) throw new ProtobufError('truncated fixed32');
        this.pos += 4;
        return;
      default:
        throw new ProtobufError(`unsupported wire type ${wire}`);
    }
  }

  /** Calls `field(no, wire)`; it returns false for fields it did not read (skipped here). */
  each(field: (no: number, wire: number) => boolean): void {
    while (!this.done) {
      const key = this.varint();
      const no = Math.floor(key / 8);
      const wire = key % 8;
      if (no === 0) throw new ProtobufError('field number 0');
      if (!field(no, wire)) this.skip(wire);
    }
  }
}

export interface TripDescriptor {
  trip_id?: string;
  route_id?: string;
  direction_id?: number;
  start_date?: string;
}

export interface VehiclePosition {
  trip?: TripDescriptor;
  vehicle_id?: string;
  vehicle_label?: string;
  lat?: number;
  lon?: number;
  bearing?: number;
  /** m/s */
  speed?: number;
  current_status?: number;
  stop_id?: string;
  timestamp?: number;
}

export interface TripUpdate {
  trip?: TripDescriptor;
  vehicle_id?: string;
  timestamp?: number;
  /** TripUpdate.delay, else the first stop-time update's arrival (or departure) delay, s. */
  delay?: number;
  headsign?: string;
}

export interface Translated {
  text: string;
  language?: string;
}

export interface EntitySelector {
  agency_id?: string;
  route_id?: string;
  stop_id?: string;
  trip?: TripDescriptor;
}

export interface Alert {
  id: string;
  active: Array<{ start?: number; end?: number }>;
  informed: EntitySelector[];
  cause?: number;
  effect?: number;
  severity?: number;
  header: Translated[];
  description: Translated[];
  url: Translated[];
}

export interface Feed {
  timestamp?: number;
  vehicles: Array<VehiclePosition & { entity_id: string }>;
  tripUpdates: TripUpdate[];
  alerts: Alert[];
}

const MAX_ENTITIES = 20_000;
const MAX_REPEATED = 200;

function trip(r: Reader): TripDescriptor {
  const t: TripDescriptor = {};
  r.each((no, wire) => {
    if (no === 1 && wire === 2) t.trip_id = r.string();
    else if (no === 3 && wire === 2) t.start_date = r.string();
    else if (no === 5 && wire === 2) t.route_id = r.string();
    else if (no === 6 && wire === 0) t.direction_id = r.varint();
    else return false;
    return true;
  });
  return t;
}

function vehicleDescriptor(r: Reader): { id?: string; label?: string } {
  const v: { id?: string; label?: string } = {};
  r.each((no, wire) => {
    if (no === 1 && wire === 2) v.id = r.string();
    else if (no === 2 && wire === 2) v.label = r.string();
    else return false;
    return true;
  });
  return v;
}

function vehiclePosition(r: Reader): VehiclePosition {
  const v: VehiclePosition = {};
  r.each((no, wire) => {
    if (no === 1 && wire === 2) v.trip = trip(r.bytes());
    else if (no === 2 && wire === 2) {
      const p = r.bytes();
      p.each((pn, pw) => {
        if (pn === 1 && pw === 5) v.lat = p.float();
        else if (pn === 2 && pw === 5) v.lon = p.float();
        else if (pn === 3 && pw === 5) v.bearing = p.float();
        else if (pn === 5 && pw === 5) v.speed = p.float();
        else return false;
        return true;
      });
    } else if (no === 4 && wire === 0) v.current_status = r.varint();
    else if (no === 5 && wire === 0) v.timestamp = r.varint();
    else if (no === 7 && wire === 2) v.stop_id = r.string();
    else if (no === 8 && wire === 2) {
      const d = vehicleDescriptor(r.bytes());
      v.vehicle_id = d.id;
      v.vehicle_label = d.label;
    } else return false;
    return true;
  });
  return v;
}

function stopTimeEventDelay(r: Reader): number | undefined {
  const ev: { delay?: number } = {};
  r.each((no, wire) => {
    if (no === 1 && wire === 0) ev.delay = r.int32();
    else return false;
    return true;
  });
  return ev.delay;
}

function tripUpdate(r: Reader): TripUpdate {
  const u: TripUpdate = {};
  const stu: { delay?: number; seen: number } = { seen: 0 };
  r.each((no, wire) => {
    if (no === 1 && wire === 2) u.trip = trip(r.bytes());
    else if (no === 2 && wire === 2) {
      const s = r.bytes();
      // Only the first update that carries a delay matters (the next stop).
      if (stu.delay !== undefined || ++stu.seen > MAX_REPEATED) return true;
      const ev: { arr?: number; dep?: number } = {};
      s.each((sn, sw) => {
        if (sn === 2 && sw === 2) ev.arr = stopTimeEventDelay(s.bytes());
        else if (sn === 3 && sw === 2) ev.dep = stopTimeEventDelay(s.bytes());
        else return false;
        return true;
      });
      stu.delay = ev.arr ?? ev.dep;
    } else if (no === 3 && wire === 2) u.vehicle_id = vehicleDescriptor(r.bytes()).id;
    else if (no === 4 && wire === 0) u.timestamp = r.varint();
    else if (no === 5 && wire === 0) u.delay = r.int32();
    else if (no === 6 && wire === 2) {
      const p = r.bytes();
      p.each((pn, pw) => {
        if (pn === 5 && pw === 2) u.headsign = p.string();
        else return false;
        return true;
      });
    } else return false;
    return true;
  });
  if (u.delay === undefined) u.delay = stu.delay;
  return u;
}

function translated(r: Reader): Translated[] {
  const out: Translated[] = [];
  r.each((no, wire) => {
    if (no !== 1 || wire !== 2) return false;
    const t = r.bytes();
    const x: Partial<Translated> = {};
    t.each((tn, tw) => {
      if (tn === 1 && tw === 2) x.text = t.string();
      else if (tn === 2 && tw === 2) x.language = t.string();
      else return false;
      return true;
    });
    if (x.text !== undefined && out.length < 10) out.push({ text: x.text, language: x.language });
    return true;
  });
  return out;
}

function alert(r: Reader, id: string): Alert {
  const a: Alert = { id, active: [], informed: [], header: [], description: [], url: [] };
  r.each((no, wire) => {
    if (no === 1 && wire === 2) {
      const t = r.bytes();
      const range: { start?: number; end?: number } = {};
      t.each((tn, tw) => {
        if (tn === 1 && tw === 0) range.start = t.varint();
        else if (tn === 2 && tw === 0) range.end = t.varint();
        else return false;
        return true;
      });
      if (a.active.length < MAX_REPEATED) a.active.push(range);
    } else if (no === 5 && wire === 2) {
      const e = r.bytes();
      const sel: EntitySelector = {};
      e.each((en, ew) => {
        if (en === 1 && ew === 2) sel.agency_id = e.string();
        else if (en === 2 && ew === 2) sel.route_id = e.string();
        else if (en === 4 && ew === 2) sel.trip = trip(e.bytes());
        else if (en === 5 && ew === 2) sel.stop_id = e.string();
        else return false;
        return true;
      });
      if (a.informed.length < MAX_REPEATED) a.informed.push(sel);
    } else if (no === 6 && wire === 0) a.cause = r.varint();
    else if (no === 7 && wire === 0) a.effect = r.varint();
    else if (no === 8 && wire === 2) a.url = translated(r.bytes());
    else if (no === 10 && wire === 2) a.header = translated(r.bytes());
    else if (no === 11 && wire === 2) a.description = translated(r.bytes());
    else if (no === 14 && wire === 0) a.severity = r.varint();
    else return false;
    return true;
  });
  return a;
}

/** Decodes a GTFS-Realtime FeedMessage. Throws ProtobufError on malformed input. */
export function decodeFeed(buf: Uint8Array): Feed {
  const r = new Reader(buf);
  const feed: Feed = { vehicles: [], tripUpdates: [], alerts: [] };
  let entities = 0;
  r.each((no, wire) => {
    if (no === 1 && wire === 2) {
      const h = r.bytes();
      h.each((hn, hw) => {
        if (hn === 3 && hw === 0) feed.timestamp = h.varint();
        else return false;
        return true;
      });
    } else if (no === 2 && wire === 2) {
      if (++entities > MAX_ENTITIES) throw new ProtobufError('too many entities');
      const e = r.bytes();
      const got: {
        id: string;
        deleted: boolean;
        vp?: VehiclePosition;
        tu?: TripUpdate;
        al?: Reader;
      } = { id: '', deleted: false };
      e.each((en, ew) => {
        if (en === 1 && ew === 2) got.id = e.string();
        else if (en === 2 && ew === 0) got.deleted = e.varint() !== 0;
        else if (en === 3 && ew === 2) got.tu = tripUpdate(e.bytes());
        else if (en === 4 && ew === 2) got.vp = vehiclePosition(e.bytes());
        else if (en === 5 && ew === 2) got.al = e.bytes();
        else return false;
        return true;
      });
      if (got.deleted) return true;
      if (got.vp) feed.vehicles.push({ ...got.vp, entity_id: got.id });
      if (got.tu) feed.tripUpdates.push(got.tu);
      if (got.al) feed.alerts.push(alert(got.al, got.id));
    } else return false;
    return true;
  });
  return feed;
}

export const ALERT_CAUSES: Record<number, string> = {
  1: 'unknown cause',
  2: 'other cause',
  3: 'technical problem',
  4: 'strike',
  5: 'demonstration',
  6: 'accident',
  7: 'holiday',
  8: 'weather',
  9: 'maintenance',
  10: 'construction',
  11: 'police activity',
  12: 'medical emergency',
};

export const ALERT_EFFECTS: Record<number, string> = {
  1: 'no service',
  2: 'reduced service',
  3: 'significant delays',
  4: 'detour',
  5: 'additional service',
  6: 'modified service',
  7: 'other effect',
  8: 'unknown effect',
  9: 'stop moved',
  10: 'no effect',
  11: 'accessibility issue',
};

export const VEHICLE_STATUS: Record<number, string> = {
  0: 'arriving at a stop',
  1: 'stopped at a stop',
  2: 'in transit',
};
