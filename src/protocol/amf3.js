const MARKER = {
  undefined: 0x00,
  null: 0x01,
  false: 0x02,
  true: 0x03,
  integer: 0x04,
  double: 0x05,
  string: 0x06,
  xmlDocument: 0x07,
  date: 0x08,
  array: 0x09,
  object: 0x0a,
  xml: 0x0b,
  byteArray: 0x0c,
  vectorInt: 0x0d,
  vectorUint: 0x0e,
  vectorDouble: 0x0f,
  vectorObject: 0x10,
  dictionary: 0x11
};

class Writer {
  constructor() {
    this.chunks = [];
  }

  bytes(value) {
    this.chunks.push(Buffer.from(value));
  }

  u8(value) {
    this.bytes([value & 0xff]);
  }

  double(value) {
    const out = Buffer.allocUnsafe(8);
    out.writeDoubleBE(value);
    this.bytes(out);
  }

  result() {
    return Buffer.concat(this.chunks);
  }
}

export class Amf3Encoder {
  constructor() {
    this.writer = new Writer();
  }

  encode(value) {
    this.writeValue(value);
    return this.writer.result();
  }

  writeU29(value) {
    value &= 0x1fffffff;
    if (value < 0x80) {
      this.writer.u8(value);
    } else if (value < 0x4000) {
      this.writer.u8((value >> 7) | 0x80);
      this.writer.u8(value & 0x7f);
    } else if (value < 0x200000) {
      this.writer.u8((value >> 14) | 0x80);
      this.writer.u8(((value >> 7) & 0x7f) | 0x80);
      this.writer.u8(value & 0x7f);
    } else {
      this.writer.u8(((value >> 22) & 0x7f) | 0x80);
      this.writer.u8(((value >> 15) & 0x7f) | 0x80);
      this.writer.u8(((value >> 8) & 0x7f) | 0x80);
      this.writer.u8(value & 0xff);
    }
  }

  writeStringData(value) {
    const bytes = Buffer.from(String(value), "utf8");
    this.writeU29((bytes.length << 1) | 1);
    this.writer.bytes(bytes);
  }

  writeValue(value) {
    if (value === undefined) {
      this.writer.u8(MARKER.undefined);
      return;
    }
    if (value === null) {
      this.writer.u8(MARKER.null);
      return;
    }
    if (value === false) {
      this.writer.u8(MARKER.false);
      return;
    }
    if (value === true) {
      this.writer.u8(MARKER.true);
      return;
    }
    if (typeof value === "number") {
      if (Number.isInteger(value) && value >= -0x10000000 && value <= 0x0fffffff) {
        this.writer.u8(MARKER.integer);
        this.writeU29(value & 0x1fffffff);
      } else {
        this.writer.u8(MARKER.double);
        this.writer.double(value);
      }
      return;
    }
    if (typeof value === "string") {
      this.writer.u8(MARKER.string);
      this.writeStringData(value);
      return;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      this.writer.u8(MARKER.byteArray);
      this.writeU29((bytes.length << 1) | 1);
      this.writer.bytes(bytes);
      return;
    }
    if (value instanceof Date) {
      this.writer.u8(MARKER.date);
      this.writeU29(1);
      this.writer.double(value.getTime());
      return;
    }
    if (Array.isArray(value)) {
      this.writer.u8(MARKER.array);
      this.writeU29((value.length << 1) | 1);
      this.writeStringData("");
      for (const item of value) this.writeValue(item);
      return;
    }
    if (typeof value === "object") {
      this.writer.u8(MARKER.object);
      this.writeU29(0x0b); // inline object, inline traits, dynamic, no sealed fields
      this.writeStringData("");
      for (const [key, item] of Object.entries(value)) {
        this.writeStringData(key);
        this.writeValue(item);
      }
      this.writeStringData("");
      return;
    }
    throw new TypeError(`Unsupported AMF3 value: ${typeof value}`);
  }
}

export class Amf3Decoder {
  constructor(buffer, offset = 0) {
    this.buffer = Buffer.from(buffer);
    this.offset = offset;
    this.strings = [];
    this.objects = [];
    this.traits = [];
  }

  ensure(length) {
    if (this.offset + length > this.buffer.length) {
      throw new RangeError(`AMF3 buffer ended at ${this.offset}, need ${length} more bytes`);
    }
  }

  u8() {
    this.ensure(1);
    return this.buffer[this.offset++];
  }

  i32() {
    this.ensure(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  u32() {
    this.ensure(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  double() {
    this.ensure(8);
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  bytes(length) {
    this.ensure(length);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readU29() {
    let value = this.u8();
    if (value < 128) return value;
    value = (value & 0x7f) << 7;
    let next = this.u8();
    if (next < 128) return value | next;
    value = (value | (next & 0x7f)) << 7;
    next = this.u8();
    if (next < 128) return value | next;
    value = (value | (next & 0x7f)) << 8;
    return (value | this.u8()) >>> 0;
  }

  readStringData() {
    const header = this.readU29();
    if ((header & 1) === 0) {
      const value = this.strings[header >> 1];
      if (value === undefined) throw new Error(`Invalid AMF3 string reference ${header >> 1}`);
      return value;
    }
    const length = header >> 1;
    if (length === 0) return "";
    const value = this.bytes(length).toString("utf8");
    this.strings.push(value);
    return value;
  }

  readValue() {
    const marker = this.u8();
    switch (marker) {
      case MARKER.undefined:
        return undefined;
      case MARKER.null:
        return null;
      case MARKER.false:
        return false;
      case MARKER.true:
        return true;
      case MARKER.integer: {
        const value = this.readU29();
        return value & 0x10000000 ? value - 0x20000000 : value;
      }
      case MARKER.double:
        return this.double();
      case MARKER.string:
        return this.readStringData();
      case MARKER.xmlDocument:
      case MARKER.xml:
        return this.readXml();
      case MARKER.date:
        return this.readDate();
      case MARKER.array:
        return this.readArray();
      case MARKER.object:
        return this.readObject();
      case MARKER.byteArray:
        return this.readByteArray();
      case MARKER.vectorInt:
        return this.readVector("int");
      case MARKER.vectorUint:
        return this.readVector("uint");
      case MARKER.vectorDouble:
        return this.readVector("double");
      case MARKER.vectorObject:
        return this.readVector("object");
      case MARKER.dictionary:
        return this.readDictionary();
      default:
        throw new Error(`Unsupported AMF3 marker 0x${marker.toString(16)} at ${this.offset - 1}`);
    }
  }

  readReferenceHeader(kind) {
    const header = this.readU29();
    if ((header & 1) === 0) {
      const value = this.objects[header >> 1];
      if (value === undefined) throw new Error(`Invalid AMF3 ${kind} reference ${header >> 1}`);
      return { reference: true, value };
    }
    return { reference: false, header };
  }

  readXml() {
    const info = this.readReferenceHeader("XML");
    if (info.reference) return info.value;
    const value = this.bytes(info.header >> 1).toString("utf8");
    this.objects.push(value);
    return value;
  }

  readDate() {
    const info = this.readReferenceHeader("date");
    if (info.reference) return info.value;
    const value = new Date(this.double());
    this.objects.push(value);
    return value;
  }

  readArray() {
    const info = this.readReferenceHeader("array");
    if (info.reference) return info.value;
    const denseLength = info.header >> 1;
    const array = [];
    this.objects.push(array);
    let key = this.readStringData();
    while (key !== "") {
      array[key] = this.readValue();
      key = this.readStringData();
    }
    for (let i = 0; i < denseLength; i += 1) array.push(this.readValue());
    return array;
  }

  readObject() {
    const header = this.readU29();
    if ((header & 1) === 0) {
      const value = this.objects[header >> 1];
      if (value === undefined) throw new Error(`Invalid AMF3 object reference ${header >> 1}`);
      return value;
    }

    let trait;
    if ((header & 2) === 0) {
      trait = this.traits[header >> 2];
      if (!trait) throw new Error(`Invalid AMF3 trait reference ${header >> 2}`);
    } else {
      const sealedCount = header >> 4;
      trait = {
        className: this.readStringData(),
        externalizable: Boolean(header & 4),
        dynamic: Boolean(header & 8),
        sealed: []
      };
      for (let i = 0; i < sealedCount; i += 1) trait.sealed.push(this.readStringData());
      this.traits.push(trait);
    }

    const object = trait.className ? { _className: trait.className } : {};
    const referenceIndex = this.objects.push(object) - 1;
    if (trait.externalizable) {
      const value = this.readValue();
      if (trait.className === "flex.messaging.io.ArrayCollection" && Array.isArray(value)) {
        this.objects[referenceIndex] = value;
        return value;
      }
      object.value = value;
      return object;
    }
    for (const key of trait.sealed) object[key] = this.readValue();
    if (trait.dynamic) {
      let key = this.readStringData();
      while (key !== "") {
        object[key] = this.readValue();
        key = this.readStringData();
      }
    }
    return object;
  }

  readByteArray() {
    const info = this.readReferenceHeader("byte array");
    if (info.reference) return info.value;
    const value = Buffer.from(this.bytes(info.header >> 1));
    this.objects.push(value);
    return value;
  }

  readVector(type) {
    const info = this.readReferenceHeader("vector");
    if (info.reference) return info.value;
    const length = info.header >> 1;
    this.u8(); // fixed-length flag
    if (type === "object") this.readStringData();
    const value = [];
    this.objects.push(value);
    for (let i = 0; i < length; i += 1) {
      if (type === "int") value.push(this.i32());
      else if (type === "uint") value.push(this.u32());
      else if (type === "double") value.push(this.double());
      else value.push(this.readValue());
    }
    return value;
  }

  readDictionary() {
    const info = this.readReferenceHeader("dictionary");
    if (info.reference) return info.value;
    const length = info.header >> 1;
    this.u8(); // weak-keys flag
    const map = new Map();
    this.objects.push(map);
    for (let i = 0; i < length; i += 1) map.set(this.readValue(), this.readValue());
    return map;
  }
}

export function encodeAmf3(value) {
  return new Amf3Encoder().encode(value);
}

export function decodeAmf3(buffer, offset = 0) {
  const decoder = new Amf3Decoder(buffer, offset);
  const value = decoder.readValue();
  return { value, offset: decoder.offset };
}
