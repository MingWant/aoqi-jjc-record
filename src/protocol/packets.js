import { Amf3Decoder, encodeAmf3 } from "./amf3.js";

function int32(value) {
  return value | 0;
}

function as3Mod(dividend, divisor) {
  return dividend % divisor;
}

function writeUtf(value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > 0xffff) throw new RangeError("Socket UTF value is too long");
  const output = Buffer.allocUnsafe(2 + bytes.length);
  output.writeUInt16BE(bytes.length, 0);
  bytes.copy(output, 2);
  return output;
}

function readUtf(buffer, offset) {
  if (offset + 2 > buffer.length) throw new RangeError("Missing socket UTF length");
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  if (start + length > buffer.length) throw new RangeError("Socket UTF exceeds packet size");
  return { value: buffer.subarray(start, start + length).toString("utf8"), offset: start + length };
}

function xorWithPacketNumber(payload, packetNumber) {
  const key = Buffer.allocUnsafe(4);
  key.writeUInt32BE(packetNumber >>> 0);
  const output = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) output[i] = payload[i] ^ key[i % 4];
  return output;
}

export class MessageSequence {
  constructor(sessionId) {
    this.hashSessionId = 0;
    for (let i = 0; i < sessionId.length; i += 1) {
      this.hashSessionId = int32(this.hashSessionId * 31 + sessionId.charCodeAt(i));
    }
    this.first = true;
  }

  next(packetNumber, userId) {
    if (packetNumber === 0 && this.first) {
      this.first = false;
      return 79;
    }
    let value = int32(packetNumber * 2 + as3Mod(userId, 653) + as3Mod(this.hashSessionId, 471));
    if (value >= 2147483647) value = int32(as3Mod(value, 1047483647) + 1);
    return value;
  }
}

export class XtPacketEncoder {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.messageNumbers = new Map();
    this.initialized = false;
    this.seed = 0;
    this.userId = 0;
    this.packetNumber = 0;
    this.sequence = null;
  }

  initialize(sessionId, userId) {
    this.sequence = new MessageSequence(sessionId);
    this.userId = int32(userId);
    this.packetNumber = 0;
    this.messageNumbers.clear();
    this.initialized = false;
    this.seed = 0;
  }

  buildLoginPacket(zone, username, sessionId) {
    const header = Buffer.allocUnsafe(7);
    header.writeUInt8(0, 0);
    header.writeUInt16BE(10016, 1);
    header.writeInt32BE(-1, 3);
    const payload = Buffer.concat([header, writeUtf(zone), writeUtf(username), writeUtf(sessionId)]);
    return this.wrap(payload, 0);
  }

  buildXtPacket(messageId, command, params = {}, routeId = -1) {
    if (!this.sequence) throw new Error("XT encoder session is not initialized");
    const messageNumber = this.nextMessageNumber(messageId);
    const inner = encodeAmf3({ ...params, ":ext_seq;": messageNumber });
    const body = encodeAmf3({ data: encryptPayloadData(messageNumber, inner) });
    const header = Buffer.allocUnsafe(9);
    header.writeUInt8(1, 0);
    header.writeUInt16BE(10033, 1);
    header.writeInt32BE(routeId, 3);
    header.writeInt16BE(messageId, 7);
    const payload = Buffer.concat([header, writeUtf(command), body]);
    this.packetNumber = this.sequence.next(this.packetNumber, this.userId);
    return this.wrap(payload, this.packetNumber);
  }

  wrap(payload, packetNumber) {
    const encrypted = xorWithPacketNumber(payload, packetNumber);
    const packet = Buffer.allocUnsafe(8 + encrypted.length);
    packet.writeUInt32BE(encrypted.length + 4, 0);
    packet.writeUInt32BE(packetNumber >>> 0, 4);
    encrypted.copy(packet, 8);
    return packet;
  }

  nextMessageNumber(messageId) {
    const current = this.messageNumbers.get(messageId) ?? 0;
    const next = this.generateMessageNumber(current);
    this.messageNumbers.set(messageId, next);
    return next;
  }

  generateMessageNumber(current) {
    let local14 = this.userId;
    let local13 = current | 0;
    let local10 = 123459876;
    let local5 = 72;
    let local12;
    let local11;
    if (local13 !== 0) {
      local12 = as3Mod(local14, 108);
      local11 = (local13 >>> 1) & 0x0ffffffe;
      local12 += local11;
      local5 = int32(local12 << 2);
      if (local12 >= 123216728) local5 = 816;
    }
    if (!this.initialized) {
      this.seed = int32(Math.floor(this.now() / 1000));
      if (this.seed === 0) this.seed = int32(this.now());
      this.initialized = true;
    }
    local14 = this.seed || 123459876;
    if (this.seed === 0) this.seed = local14;
    local12 = Math.trunc(local14 / 127773) * -2836;
    local11 = as3Mod(local14, 127773) * 16807;
    local13 = int32(local11 + local12);
    local14 = local13 < 0 ? int32(local13 + 2147483647) : local13;
    local13 = local14 !== 0 ? local14 : local10;
    local12 = Math.trunc(local13 / 127773) * -2836;
    local11 = as3Mod(local13, 127773) * 16807;
    let local9 = int32(local11 + local12);
    local13 = local9 < 0 ? int32(local9 + 2147483647) : local9;
    if (local13 !== 0) local10 = local13;
    local12 = Math.trunc(local10 / 127773) * -2836;
    local11 = as3Mod(local10, 127773) * 16807;
    local10 = int32(local11 + local12);
    local9 = local10 < 0 ? int32(local10 + 2147483647) : local10;
    this.seed = local9;
    local12 = local9 & 3;
    local12 |= local5;
    local11 = int32(local13 << 2);
    const local8 = int32(local14 << 17);
    local11 = int32(local11 + local8) & -536870912;
    local12 |= local11;
    return int32(local12);
  }
}

export function encryptPayloadData(key, data) {
  let normalizedKey = key | 0;
  if (normalizedKey !== 0) normalizedKey = (normalizedKey & 0x1ffffffc) >> 2;
  const xorKey = [
    (normalizedKey >> 22) & 0xff,
    (normalizedKey >> 18) & 0xff,
    (normalizedKey >> 9) & 0xff,
    (normalizedKey >> 2) & 0xff
  ];
  const output = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) output[i] = data[i] ^ xorKey[i % 4];
  for (let block = 0; block < Math.floor(output.length / 4); block += 1) {
    const base = block * 4;
    if (block % 2 === 0) [output[base], output[base + 2]] = [output[base + 2], output[base]];
    else [output[base + 1], output[base + 3]] = [output[base + 3], output[base + 1]];
  }
  return output;
}

function tryDecodeLoginPayload(decoded, offset = 0) {
  try {
    const decoder = new Amf3Decoder(decoded, offset);
    const result = {};
    for (let i = 0; i < 4; i += 1) {
      const key = decoder.readStringData();
      if (!key || key.length > 80) return null;
      result[key] = decoder.readValue();
    }
    if (!("id" in result) && !("lastLoginTime" in result)) return null;
    return result;
  } catch {
    return null;
  }
}

function tryDecodeXt(decoded, packetNumber) {
  if (decoded.length < 11 || decoded.readUInt16BE(1) !== 10033) return null;
  try {
    const flag = decoded.readUInt8(0);
    const routeId = decoded.readInt32BE(3);
    const messageId = decoded.readInt16BE(7);
    const command = readUtf(decoded, 9);
    const decoder = new Amf3Decoder(decoded, command.offset);
    const body = decoder.readValue();
    return { type: "xt", flag, packetNumber, routeId, messageId, cmd: command.value, body };
  } catch {
    return null;
  }
}

function tryDecodePlain(packet) {
  if (packet.length < 6) return null;
  try {
    const flag = packet.readUInt8(4);
    const decoder = new Amf3Decoder(packet, 5);
    const body = decoder.readValue();
    const cmd = body && typeof body === "object" ? String(body._cmd ?? "") : "";
    return { type: "amf", flag, packetNumber: 0, routeId: -1, messageId: -1, cmd, body };
  } catch {
    return null;
  }
}

export function decodeTransportPacket(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 8) return null;
  const declaredLength = packet.readUInt32BE(0);
  if (declaredLength + 4 > packet.length) return null;
  const plainLogin = tryDecodeLoginPayload(packet, 8) ?? tryDecodeLoginPayload(packet, 15);
  if (plainLogin) return { type: "login", packetNumber: 0, messageId: -1, cmd: "", body: plainLogin };
  const packetNumber = packet.readUInt32BE(4);
  const decoded = xorWithPacketNumber(packet.subarray(8, 4 + declaredLength), packetNumber);
  const xt = tryDecodeXt(decoded, packetNumber);
  if (xt) return xt;
  const login = tryDecodeLoginPayload(decoded, 0) ?? tryDecodeLoginPayload(decoded, 7);
  if (login) return { type: "login", packetNumber, messageId: -1, cmd: "", body: login };
  return tryDecodePlain(packet);
}
