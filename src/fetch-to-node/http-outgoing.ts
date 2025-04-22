/*
 * Copyright Michael Hart
 * Licensed under the MIT license. See LICENSE file for details.
 *
 * Portions of this file Copyright Fastly, Inc. See LICENSE file for details.
 * Portions of this file Copyright Joyent, Inc. and other Node contributors. See LICENSE file for details.
 */

// This file modeled after Node.js - node/lib/_http_outgoing.js

import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import type {
  OutgoingHttpHeaders,
  OutgoingMessage,
  IncomingMessage,
  OutgoingHttpHeader,
} from "node:http";

import {
  ERR_HTTP_HEADERS_SENT,
  ERR_HTTP_INVALID_HEADER_VALUE,
  ERR_HTTP_TRAILER_INVALID,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_CHAR,
  ERR_INVALID_HTTP_TOKEN,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_STREAM_ALREADY_FINISHED,
  ERR_STREAM_CANNOT_PIPE,
  ERR_STREAM_DESTROYED,
  ERR_STREAM_NULL_VALUES,
  ERR_STREAM_WRITE_AFTER_END,
} from "../utils/errors.js";
import { isUint8Array, validateString } from "../utils/types.js";
import { kNeedDrain, kOutHeaders, utcDate } from "./internal-http.js";
import { getDefaultHighWaterMark } from "./internal-streams-state.js";
import {
  checkInvalidHeaderChar,
  checkIsHttpToken,
  chunkExpression as RE_TE_CHUNKED,
} from "./http-common.js";

const kCorked = Symbol("corked");
const kUniqueHeaders = Symbol("kUniqueHeaders");

function debug(format: string) {
  // console.log("http " + format);
}

/* These items copied from Node.js: node/lib/_http_outgoing.js. */

const nop = () => {};
const RE_CONN_CLOSE = /(?:^|\W)close(?:$|\W)/i;
const HIGH_WATER_MARK = getDefaultHighWaterMark();

function validateHeaderName(name: string) {
  if (typeof name !== "string" || !name || !checkIsHttpToken(name)) {
    throw new ERR_INVALID_HTTP_TOKEN("Header name", name);
  }
}

function validateHeaderValue(
  name: string,
  value: number | string | ReadonlyArray<string> | undefined
) {
  if (value === undefined) {
    throw new ERR_HTTP_INVALID_HEADER_VALUE(String(value), name);
  }
  if (checkInvalidHeaderChar(String(value))) {
    debug(`Header "${name}" contains invalid characters`);
    throw new ERR_INVALID_CHAR("header content", name);
  }
}

// isCookieField performs a case-insensitive comparison of a provided string
// against the word "cookie." As of V8 6.6 this is faster than handrolling or
// using a case-insensitive RegExp.
function isCookieField(s: string) {
  return s.length === 6 && s.toLowerCase() === "cookie";
}

type WriteCallback = (err?: Error) => void;

type OutputData = {
  data: string | Buffer | Uint8Array;
  encoding: BufferEncoding | undefined;
  callback: WriteCallback | undefined;
};

type WrittenDataBufferEntry = OutputData & {
  length: number;
  written: boolean;
};

type WrittenDataBufferConstructorArgs = {
  onWrite?: (index: number, entry: WrittenDataBufferEntry) => void;
};
/**
 * An in-memory buffer that stores the chunks that have been streamed to an
 * OutgoingMessage instance.
 */
export class WrittenDataBuffer {
  [kCorked]: number = 0;
  entries: WrittenDataBufferEntry[] = [];
  onWrite?: (index: number, entry: WrittenDataBufferEntry) => void;

  constructor(params: WrittenDataBufferConstructorArgs = {}) {
    this.onWrite = params.onWrite;
  }

  write(
    data: string | Uint8Array,
    encoding?: BufferEncoding,
    callback?: WriteCallback
  ) {
    this.entries.push({
      data,
      length: data.length,
      encoding,
      callback,
      written: false,
    });
    this._flush();

    return true;
  }

  cork() {
    this[kCorked]++;
  }

  uncork() {
    this[kCorked]--;
    this._flush();
  }

  _flush() {
    if (this[kCorked] <= 0) {
      for (const [index, entry] of this.entries.entries()) {
        if (!entry.written) {
          entry.written = true;
          if (this.onWrite != null) {
            this.onWrite(index, entry);
          }
          if (entry.callback != null) {
            entry.callback.call(undefined);
          }
        }
      }
    }
  }

  get writableLength() {
    return this.entries.reduce<number>((acc, entry) => {
      return acc + (entry.written! && entry.length! ? entry.length : 0);
    }, 0);
  }

  get writableHighWaterMark() {
    return HIGH_WATER_MARK;
  }

  get writableCorked() {
    return this[kCorked];
  }
}

export type HeadersSentEvent = {
  statusCode: number;
  statusMessage: string;
  headers: [header: string, value: string][];
};

export type DataWrittenEvent = {
  index: number;
  entry: WrittenDataBufferEntry;
};

/**
 * This is an implementation of OutgoingMessage from Node.js intended to run in
 * a WinterTC runtime. The 'Writable' interface of this class is wired to an in-memory
 * buffer.
 *
 * This instance can be used in normal ways, but it does not give access to the
 * underlying socket (because there isn't one. req.socket will always return null).
 *
 * Some code in this class is transplanted/adapted from node/lib/_http_outgoing.js
 */
export class FetchOutgoingMessage extends Writable implements OutgoingMessage {
  // Queue that holds all currently pending data, until the response will be
  // assigned to the socket (until it will its turn in the HTTP pipeline).
  outputData: OutputData[] = [];

  // `outputSize` is an approximate measure of how much data is queued on this
  // response. `_onPendingData` will be invoked to update similar global
  // per-connection counter. That counter will be used to pause/unpause the
  // TCP socket and HTTP Parser and thus handle the backpressure.
  outputSize = 0;

  // Difference from Node.js -
  // `writtenHeaderBytes` is the number of bytes the header has taken.
  // Since Node.js writes both the headers and body into the same outgoing
  // stream, it helps to keep track of this so that we can skip that many bytes
  // from the beginning of the stream when providing the outgoing stream.
  writtenHeaderBytes = 0;

  chunkedEncoding: boolean = false;
  finished: boolean = false;
  readonly req: IncomingMessage;
  sendDate: boolean = false;
  shouldKeepAlive: boolean = true; // ??
  useChunkedEncodingByDefault: boolean = false; // Not liked by viceroy? for now disabling

  _last: boolean;
  maxRequestsOnConnectionReached: boolean;
  _defaultKeepAlive: boolean;
  _removedConnection: boolean;
  _removedContLen: boolean;
  _removedTE: boolean;

  _contentLength: number | null;
  _hasBody: boolean;
  _trailer: string;
  [kNeedDrain]: boolean;

  _headerSent: boolean;
  [kCorked]: number;
  _closed: boolean;

  _header: string | null;
  [kOutHeaders]: Record<string, any> | null;

  _keepAliveTimeout: number;

  _onPendingData: (delta: number) => void;

  [kUniqueHeaders]: Set<string> | null;

  _writtenDataBuffer: WrittenDataBuffer = new WrittenDataBuffer({
    onWrite: this._onDataWritten.bind(this),
  });

  constructor(req: IncomingMessage) {
    super();

    this.req = req;

    this._last = false;
    this.maxRequestsOnConnectionReached = false;
    this._defaultKeepAlive = true;
    this._removedConnection = false;
    this._removedContLen = false;
    this._removedTE = false;
    this._contentLength = null;
    this._hasBody = true;
    this._trailer = "";
    this[kNeedDrain] = false;
    this._headerSent = false;
    this[kCorked] = 0;
    this._closed = false;

    this._header = null;
    this[kOutHeaders] = null;

    this._keepAliveTimeout = 0;

    this._onPendingData = nop;

    this[kUniqueHeaders] = null;
  }

  get _headers() {
    console.warn("DEP0066: OutgoingMessage.prototype._headers is deprecated");
    return this.getHeaders();
  }

  set _headers(val) {
    console.warn("DEP0066: OutgoingMessage.prototype._headers is deprecated");
    if (val == null) {
      this[kOutHeaders] = null;
    } else if (typeof val === "object") {
      const headers = (this[kOutHeaders] = Object.create(null));
      const keys = Object.keys(val);
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0; i < keys.length; ++i) {
        const name = keys[i];
        headers[name.toLowerCase()] = [name, val[name]];
      }
    }
  }

  get connection() {
    // Difference from Node.js -
    // Connection is not supported
    return null;
  }

  set connection(_socket: any) {
    // Difference from Node.js -
    // Connection is not supported
    console.error("No support for OutgoingMessage.connection");
  }

  get socket() {
    // Difference from Node.js -
    // socket is not supported
    return null;
  }

  set socket(_socket: any) {
    // Difference from Node.js -
    // socket is not supported
    console.error("No support for OutgoingMessage.socket");
  }

  get _headerNames() {
    console.warn(
      "DEP0066: OutgoingMessage.prototype._headerNames is deprecated"
    );
    const headers = this[kOutHeaders];
    if (headers !== null) {
      const out = Object.create(null);
      const keys = Object.keys(headers);
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        const val = headers[key][0];
        out[key] = val;
      }
      return out;
    }
    return null;
  }

  set _headerNames(val: any) {
    console.warn(
      "DEP0066: OutgoingMessage.prototype._headerNames is deprecated"
    );
    if (typeof val === "object" && val !== null) {
      const headers = this[kOutHeaders];
      if (!headers) return;
      const keys = Object.keys(val);
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0; i < keys.length; ++i) {
        const header = headers[keys[i]];
        if (header) header[0] = val[keys[i]];
      }
    }
  }

  _renderHeaders() {
    if (this._header) {
      throw new ERR_HTTP_HEADERS_SENT("render");
    }

    const headersMap = this[kOutHeaders];
    const headers: Record<string, string> = {};

    if (headersMap !== null) {
      const keys = Object.keys(headersMap);
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0, l = keys.length; i < l; i++) {
        const key = keys[i];
        headers[headersMap[key][0]] = headersMap[key][1];
      }
    }
    return headers;
  }

  override cork(): void {
    // Difference from Node.js -
    // In Node.js, if a socket exists, we would call cork() on the socket instead
    // In our implementation, we do the same to the "written data buffer" instead.

    if (this._writtenDataBuffer != null) {
      this._writtenDataBuffer.cork();
    } else {
      this[kCorked]++;
    }
  }

  override uncork(): void {
    // Difference from Node.js -
    // In Node.js, if a socket exists, we would call uncork() on the socket instead
    // In our implementation, we do the same to the "written data buffer" instead.

    if (this._writtenDataBuffer != null) {
      this._writtenDataBuffer.uncork();
    } else {
      this[kCorked]--;
    }
  }

  setTimeout(msecs: number, callback?: () => void): this {
    // Difference from Node.js -
    // In Node.js, this is supposed to set the underlying socket to time out
    // after some time and then run a callback.
    // We do nothing here since we don't really have a way to support direct
    // access to the socket.
    return this;
  }

  override destroy(error?: Error): this {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;

    // Difference from Node.js -
    // In Node.js, we would also attempt to destroy the underlying socket.
    return this;
  }

  _send(
    data: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ) {
    // This is a shameful hack to get the headers and first body chunk onto
    // the same packet. Future versions of Node are going to take care of
    // this at a lower level and in a more general way.
    if (!this._headerSent) {
      const header = this._header!;
      if (
        typeof data === "string" &&
        (encoding === "utf8" || encoding === "latin1" || !encoding)
      ) {
        data = header + data;
      } else {
        this.outputData.unshift({
          data: header,
          encoding: "latin1",
          callback: undefined,
        });
        this.outputSize += header.length;
        this._onPendingData(header.length);
      }
      this.writtenHeaderBytes = header.length;

      // Save written headers as object
      const [statusLine, ...headerLines] = this._header!.split("\r\n");

      const STATUS_LINE_REGEXP =
        /^HTTP\/1\.1 (?<statusCode>\d+) (?<statusMessage>.*)$/;
      const statusLineResult = STATUS_LINE_REGEXP.exec(statusLine);

      if (statusLineResult == null) {
        throw new Error("Unexpected! Status line was " + statusLine);
      }

      const { statusCode: statusCodeText, statusMessage } =
        statusLineResult.groups ?? {};
      const statusCode = parseInt(statusCodeText, 10);
      const headers: [header: string, value: string][] = [];

      for (const headerLine of headerLines) {
        if (headerLine !== "") {
          const pos = headerLine.indexOf(": ");
          const k = headerLine.slice(0, pos);
          const v = headerLine.slice(pos + 2); // Skip the colon and the space
          headers.push([k, v]);
        }
      }

      this._headerSent = true;

      // Difference from Node.js -
      // After headers are 'sent', we trigger an event
      const event: HeadersSentEvent = {
        statusCode,
        statusMessage,
        headers,
      };
      this.emit("_headersSent", event);
    }
    return this._writeRaw(data, encoding, callback);
  }

  _onDataWritten(index: number, entry: WrittenDataBufferEntry) {
    const event: DataWrittenEvent = { index, entry };
    this.emit("_dataWritten", event);
  }

  _writeRaw(
    data: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ) {
    // Difference from Node.js -
    // In Node.js, we would check for an underlying socket, and if that socket
    // exists and is already destroyed, simply return false.

    let e: BufferEncoding | undefined;
    if (typeof encoding === "function") {
      callback = encoding;
      e = undefined;
    } else {
      e = encoding;
    }

    // Difference from Node.js -
    // In Node.js, we would check for an underlying socket, and if that socket
    // exists and is currently writable, it would flush any pending data to the socket and then
    // write the current chunk's data directly into the socket. Afterwards, it would return with the
    // value returned from socket.write().

    // In our implementation, instead we do the same for the "written data buffer".
    if (this._writtenDataBuffer != null) {
      // There might be pending data in the this.output buffer.
      if (this.outputData.length) {
        this._flushOutput(this._writtenDataBuffer);
      }
      // Directly write to the buffer.
      return this._writtenDataBuffer.write(data, e, callback);
    }

    // Buffer, as long as we're not destroyed.
    this.outputData.push({ data, encoding: e, callback });
    this.outputSize += data.length;
    this._onPendingData(data.length);
    return this.outputSize < HIGH_WATER_MARK;
  }

  _storeHeader(
    firstLine: string,
    headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]> | null
  ) {
    // firstLine in the case of request is: 'GET /index.html HTTP/1.1\r\n'
    // in the case of response it is: 'HTTP/1.1 200 OK\r\n'
    const state = {
      connection: false,
      contLen: false,
      te: false,
      date: false,
      expect: false,
      trailer: false,
      header: firstLine,
    };

    if (headers) {
      if (headers === this[kOutHeaders]) {
        for (const key in headers) {
          const entry = (headers as Record<string, any>)[key];
          processHeader(this, state, entry[0], entry[1], false);
        }
      } else if (Array.isArray(headers)) {
        if (headers.length && Array.isArray(headers[0])) {
          for (let i = 0; i < headers.length; i++) {
            const entry = headers[i];
            processHeader(this, state, entry[0], entry[1], true);
          }
        } else {
          if (headers.length % 2 !== 0) {
            throw new ERR_INVALID_ARG_VALUE("headers", headers);
          }

          for (let n = 0; n < headers.length; n += 2) {
            processHeader(this, state, headers[n], headers[n + 1], true);
          }
        }
      } else {
        for (const key in headers) {
          if (headers.hasOwnProperty(key)) {
            const _headers = headers as OutgoingHttpHeaders;
            processHeader(
              this,
              state,
              key,
              _headers[key] as OutgoingHttpHeader,
              true
            );
          }
        }
      }
    }

    let { header } = state;

    // Date header
    if (this.sendDate && !state.date) {
      header += "Date: " + utcDate() + "\r\n";
    }

    // Force the connection to close when the response is a 204 No Content or
    // a 304 Not Modified and the user has set a "Transfer-Encoding: chunked"
    // header.
    //
    // RFC 2616 mandates that 204 and 304 responses MUST NOT have a body but
    // node.js used to send out a zero chunk anyway to accommodate clients
    // that don't have special handling for those responses.
    //
    // It was pointed out that this might confuse reverse proxies to the point
    // of creating security liabilities, so suppress the zero chunk and force
    // the connection to close.

    // NOTE: the "as any" here is needed because 'statusCode' is only
    // defined on the subclass but is used here.
    if (
      this.chunkedEncoding &&
      ((this as any).statusCode === 204 || (this as any).statusCode === 304)
    ) {
      debug(
        (this as any).statusCode +
          " response should not use chunked encoding," +
          " closing connection."
      );
      this.chunkedEncoding = false;
      this.shouldKeepAlive = false;
    }

    // keep-alive logic
    if (this._removedConnection) {
      this._last = true;
      this.shouldKeepAlive = false;
    } else if (!state.connection) {
      // this.agent would only exist on class ClientRequest
      const shouldSendKeepAlive =
        this.shouldKeepAlive &&
        (state.contLen || this.useChunkedEncodingByDefault); /* || this.agent */
      if (shouldSendKeepAlive && this.maxRequestsOnConnectionReached) {
        header += "Connection: close\r\n";
      } else if (shouldSendKeepAlive) {
        header += "Connection: keep-alive\r\n";
        if (this._keepAliveTimeout && this._defaultKeepAlive) {
          const timeoutSeconds = Math.floor(this._keepAliveTimeout / 1000);
          header += `Keep-Alive: timeout=${timeoutSeconds}\r\n`;
        }
      } else {
        this._last = true;
        header += "Connection: close\r\n";
      }
    }

    if (!state.contLen && !state.te) {
      if (!this._hasBody) {
        // Make sure we don't end the 0\r\n\r\n at the end of the message.
        this.chunkedEncoding = false;
      } else if (!this.useChunkedEncodingByDefault) {
        this._last = true;
      } else if (
        !state.trailer &&
        !this._removedContLen &&
        typeof this._contentLength === "number"
      ) {
        header += "Content-Length: " + this._contentLength + "\r\n";
      } else if (!this._removedTE) {
        header += "Transfer-Encoding: chunked\r\n";
        this.chunkedEncoding = true;
      } else {
        // We should only be able to get here if both Content-Length and
        // Transfer-Encoding are removed by the user.
        // See: test/parallel/test-http-remove-header-stays-removed.js
        debug("Both Content-Length and Transfer-Encoding are removed");
      }
    }

    // Test non-chunked message does not have trailer header set,
    // message will be terminated by the first empty line after the
    // header fields, regardless of the header fields present in the
    // message, and thus cannot contain a message body or 'trailers'.
    if (this.chunkedEncoding !== true && state.trailer) {
      throw new ERR_HTTP_TRAILER_INVALID();
    }

    this._header = header + "\r\n";
    this._headerSent = false;

    // Wait until the first body chunk, or close(), is sent to flush,
    // UNLESS we're sending Expect: 100-continue.
    if (state.expect) {
      this._send("");
    }
  }

  setHeader(
    name: string,
    value: number | string | ReadonlyArray<string>
  ): this {
    if (this._header) {
      throw new ERR_HTTP_HEADERS_SENT("set");
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);

    let headers = this[kOutHeaders];
    if (headers === null) {
      this[kOutHeaders] = headers = Object.create(null);
    }

    headers![name.toLowerCase()] = [name, value];
    return this;
  }

  setHeaders(
    headers: Headers | Map<string, number | string | readonly string[]>
  ): this {
    for (const [name, value] of headers) {
      this.setHeader(name, value);
    }
    return this;
  }

  appendHeader(name: string, value: number | string | ReadonlyArray<string>) {
    if (this._header) {
      throw new ERR_HTTP_HEADERS_SENT("append");
    }
    validateHeaderName(name);
    validateHeaderValue(name, value);

    const field = name.toLowerCase();
    const headers = this[kOutHeaders];
    if (headers === null || !headers[field]) {
      return this.setHeader(name, value);
    }

    // Prepare the field for appending, if required
    if (!Array.isArray(headers[field][1])) {
      headers[field][1] = [headers[field][1]];
    }

    const existingValues = headers[field][1];
    if (Array.isArray(value)) {
      for (let i = 0, length = value.length; i < length; i++) {
        existingValues.push(value[i]);
      }
    } else {
      existingValues.push(value);
    }

    return this;
  }

  getHeader(name: string): number | string | string[] | undefined {
    validateString(name, "name");

    const headers = this[kOutHeaders];
    if (headers === null) {
      return undefined;
    }

    const entry = headers[name.toLowerCase()];
    return entry && entry[1];
  }

  getHeaderNames(): string[] {
    return this[kOutHeaders] !== null ? Object.keys(this[kOutHeaders]) : [];
  }

  getRawHeaderNames() {
    const headersMap = this[kOutHeaders];
    if (headersMap === null) return [];

    const values = Object.values(headersMap);
    const headers = Array(values.length);
    // Retain for(;;) loop for performance reasons
    // Refs: https://github.com/nodejs/node/pull/30958
    for (let i = 0, l = values.length; i < l; i++) {
      headers[i] = values[i][0];
    }

    return headers;
  }

  getHeaders(): OutgoingHttpHeaders {
    const headers = this[kOutHeaders];
    const ret = Object.create(null);
    if (headers) {
      const keys = Object.keys(headers);
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0; i < keys.length; ++i) {
        const key = keys[i];
        const val = headers[key][1];
        ret[key] = val;
      }
    }
    return ret;
  }

  hasHeader(name: string): boolean {
    validateString(name, "name");
    return (
      this[kOutHeaders] !== null && !!this[kOutHeaders][name.toLowerCase()]
    );
  }

  removeHeader(name: string): void {
    validateString(name, "name");

    if (this._header) {
      throw new ERR_HTTP_HEADERS_SENT("remove");
    }

    const key = name.toLowerCase();

    switch (key) {
      case "connection":
        this._removedConnection = true;
        break;
      case "content-length":
        this._removedContLen = true;
        break;
      case "transfer-encoding":
        this._removedTE = true;
        break;
      case "date":
        this.sendDate = false;
        break;
    }

    if (this[kOutHeaders] !== null) {
      delete this[kOutHeaders][key];
    }
  }

  _implicitHeader() {
    throw new ERR_METHOD_NOT_IMPLEMENTED("_implicitHeader()");
  }

  get headersSent() {
    return !!this._header;
  }

  override write(
    chunk: string | Buffer | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ): boolean {
    debug("write called");

    let e: BufferEncoding | undefined;
    if (typeof encoding === "function") {
      callback = encoding;
      e = undefined;
    } else {
      e = encoding;
    }

    const ret = write_(this, chunk, e, callback, false);
    if (!ret) {
      this[kNeedDrain] = true;
    }
    return ret;
  }

  addTrailers(
    headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>
  ): void {
    this._trailer = "";

    const isArray = Array.isArray(headers);
    const keys = isArray ? [...headers.keys()] : Object.keys(headers);
    // Retain for(;;) loop for performance reasons
    // Refs: https://github.com/nodejs/node/pull/30958
    for (let i = 0, l = keys.length; i < l; i++) {
      let field: string, value: OutgoingHttpHeader | undefined;
      if (isArray) {
        const _headers = headers as ReadonlyArray<[string, string]>;
        const key = keys[i] as number;
        field = _headers[key][0];
        value = _headers[key][1];
      } else {
        const _headers = headers as OutgoingHttpHeaders;
        const key = keys[i] as string;
        field = key;
        value = _headers[key];
      }
      if (!field || !checkIsHttpToken(field)) {
        throw new ERR_INVALID_HTTP_TOKEN("Trailer name", field);
      }

      // Check if the field must be sent several times
      if (
        Array.isArray(value) &&
        value.length > 1 &&
        (!this[kUniqueHeaders] ||
          !this[kUniqueHeaders].has(field.toLowerCase()))
      ) {
        for (let j = 0, l = value.length; j < l; j++) {
          if (checkInvalidHeaderChar(value[j])) {
            debug(`Trailer "${field}"[${j}] contains invalid characters`);
            throw new ERR_INVALID_CHAR("trailer content", field);
          }
          this._trailer += field + ": " + value[j] + "\r\n";
        }
      } else {
        if (Array.isArray(value)) {
          value = value.join("; ");
        } else {
          value = String(value);
        }

        if (checkInvalidHeaderChar(value)) {
          debug(`Trailer "${field}" contains invalid characters`);
          throw new ERR_INVALID_CHAR("trailer content", field);
        }
        this._trailer += field + ": " + value + "\r\n";
      }
    }
  }

  override end(
    chunk?: string | Buffer | Uint8Array | WriteCallback,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ) {
    let ch: string | Buffer | Uint8Array | undefined;
    let e: BufferEncoding | undefined;
    if (typeof chunk === "function") {
      callback = chunk;
      ch = undefined;
      e = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      ch = chunk;
      e = undefined;
    } else {
      ch = chunk;
      e = encoding;
    }

    if (ch) {
      if (this.finished) {
        onError(
          this,
          new ERR_STREAM_WRITE_AFTER_END(),
          typeof callback !== "function" ? nop : callback
        );
        return this;
      }

      // Difference from Node.js -
      // In Node.js, if a socket exists, we would also call socket.cork() at this point.
      // For our implementation we do the same for the "written data buffer"
      if (this._writtenDataBuffer != null) {
        this._writtenDataBuffer.cork();
      }
      write_(this, ch, e, undefined, true);
    } else if (this.finished) {
      if (typeof callback === "function") {
        if (!this.writableFinished) {
          this.on("finish", callback);
        } else {
          callback(new ERR_STREAM_ALREADY_FINISHED("end"));
        }
      }
      return this;
    } else if (!this._header) {
      // Difference from Node.js -
      // In Node.js, if a socket exists, we would also call socket.cork() at this point.
      // For our implementation we do the same for the "written data buffer"
      if (this._writtenDataBuffer != null) {
        this._writtenDataBuffer.cork();
      }
      this._contentLength = 0;
      this._implicitHeader();
    }

    if (typeof callback === "function") this.once("finish", callback);

    const finish = onFinish.bind(undefined, this);

    if (this._hasBody && this.chunkedEncoding) {
      this._send("0\r\n" + this._trailer + "\r\n", "latin1", finish);
    } else if (!this._headerSent || this.writableLength || ch) {
      this._send("", "latin1", finish);
    } else {
      setTimeout(finish, 0);
    }

    // Difference from Node.js -
    // In Node.js, if a socket exists, we would also call socket.uncork() at this point.
    // For our implementation we do the same for the "written data buffer"
    if (this._writtenDataBuffer != null) {
      this._writtenDataBuffer.uncork();
    }
    this[kCorked] = 0;

    this.finished = true;

    // There is the first message on the outgoing queue, and we've sent
    // everything to the socket.
    debug("outgoing message end.");
    // Difference from Node.js -
    // In Node.js, if a socket exists, and there is no pending output data,
    // we would also call this._finish() at this point.
    // For our implementation we do the same for the "written data buffer"

    if (this.outputData.length === 0 && this._writtenDataBuffer != null) {
      this._finish();
    }

    return this;
  }

  _finish() {
    // Difference from Node.js -
    // In Node.js, this function is only called if a socket exists.
    // This function would assert() for a socket and then emit 'prefinish'.
    // For our implementation we do the same for the "written data buffer"
    this.emit("prefinish");
  }

  _flushOutput(dataBuffer: WrittenDataBuffer) {
    while (this[kCorked]) {
      this[kCorked]--;
      dataBuffer.cork();
    }

    const outputLength = this.outputData.length;
    if (outputLength <= 0) return undefined;

    const outputData = this.outputData;
    dataBuffer.cork();
    let ret;
    // Retain for(;;) loop for performance reasons
    // Refs: https://github.com/nodejs/node/pull/30958
    for (let i = 0; i < outputLength; i++) {
      const { data, encoding, callback } = outputData[i];
      ret = dataBuffer.write(data, encoding, callback);
    }
    dataBuffer.uncork();

    this.outputData = [];
    this._onPendingData(-this.outputSize);
    this.outputSize = 0;

    return ret;
  }

  flushHeaders(): void {
    if (!this._header) {
      this._implicitHeader();
    }

    // Force-flush the headers.
    this._send("");
  }

  override pipe<T extends NodeJS.WritableStream>(destination: T): T {
    // OutgoingMessage should be write-only. Piping from it is disabled.
    this.emit("error", new ERR_STREAM_CANNOT_PIPE());
    return destination;
  }
}

type HeaderState = {
  connection: boolean;
  contLen: boolean;
  te: boolean;
  date: boolean;
  expect: boolean;
  trailer: boolean;
  header: string;
};

function processHeader(
  self: FetchOutgoingMessage,
  state: HeaderState,
  key: string,
  value: OutgoingHttpHeader,
  validate: boolean
) {
  if (validate) {
    validateHeaderName(key);
  }
  if (Array.isArray(value)) {
    if (
      (value.length < 2 || !isCookieField(key)) &&
      (!self[kUniqueHeaders] || !self[kUniqueHeaders].has(key.toLowerCase()))
    ) {
      // Retain for(;;) loop for performance reasons
      // Refs: https://github.com/nodejs/node/pull/30958
      for (let i = 0; i < value.length; i++) {
        storeHeader(self, state, key, value[i], validate);
      }
      return;
    }
    value = value.join("; ");
  }
  storeHeader(self, state, key, String(value), validate);
}

function storeHeader(
  self: FetchOutgoingMessage,
  state: HeaderState,
  key: string,
  value: string,
  validate: boolean
) {
  if (validate) {
    validateHeaderValue(key, value);
  }
  state.header += key + ": " + value + "\r\n";
  matchHeader(self, state, key, value);
}

function matchHeader(
  self: FetchOutgoingMessage,
  state: HeaderState,
  field: string,
  value: string
) {
  if (field.length < 4 || field.length > 17) return;
  field = field.toLowerCase();
  switch (field) {
    case "connection":
      state.connection = true;
      self._removedConnection = false;
      if (RE_CONN_CLOSE.exec(value) !== null) self._last = true;
      else self.shouldKeepAlive = true;
      break;
    case "transfer-encoding":
      state.te = true;
      self._removedTE = false;
      if (RE_TE_CHUNKED.exec(value) !== null) self.chunkedEncoding = true;
      break;
    case "content-length":
      state.contLen = true;
      self._removedContLen = false;
      break;
    case "date":
    case "expect":
    case "trailer":
      state[field] = true;
      break;
    case "keep-alive":
      self._defaultKeepAlive = false;
      break;
  }
}

const crlf_buf = Buffer.from("\r\n");

function onError(
  msg: FetchOutgoingMessage,
  err: Error,
  callback: WriteCallback
) {
  // Difference from Node.js -
  // In Node.js, we would check for the existence of a socket. If one exists, we would
  // use that async ID to scope the error.
  // Instead, we do this.
  setTimeout(emitErrorNt, 0, msg, err, callback);
}

function emitErrorNt(
  msg: FetchOutgoingMessage,
  err: Error,
  callback: WriteCallback
) {
  callback(err);
  if (typeof msg.emit === "function" && !msg._closed) {
    msg.emit("error", err);
  }
}

function write_(
  msg: FetchOutgoingMessage,
  chunk: string | Buffer | Uint8Array,
  encoding: BufferEncoding | undefined,
  callback: WriteCallback | undefined,
  fromEnd: boolean
) {
  debug("write_");

  if (typeof callback !== "function") {
    callback = nop;
  }

  let len: number;
  if (chunk === null) {
    debug("ERR_STREAM_NULL_VALUES");
    throw new ERR_STREAM_NULL_VALUES();
  } else if (typeof chunk === "string") {
    len = Buffer.byteLength(chunk, encoding ?? undefined);
  } else if (isUint8Array(chunk)) {
    len = chunk.length;
  } else {
    debug("ERR_INVALID_ARG_TYPE");
    throw new ERR_INVALID_ARG_TYPE(
      "chunk",
      ["string", "Buffer", "Uint8Array"],
      chunk
    );
  }

  let err: Error | undefined = undefined;
  if (msg.finished) {
    err = new ERR_STREAM_WRITE_AFTER_END();
  } else if (msg.destroyed) {
    err = new ERR_STREAM_DESTROYED("write");
  }

  if (err) {
    debug("err:" + err);
    if (!msg.destroyed) {
      onError(msg, err, callback);
    } else {
      setTimeout(callback, 0, err);
    }
    return false;
  }

  if (!msg._header) {
    debug("!msg._header");
    if (fromEnd) {
      msg._contentLength = len;
    }
    msg._implicitHeader();
  }

  if (!msg._hasBody) {
    debug("!msg._hasBody");
    debug(
      "This type of response MUST NOT have a body. " + "Ignoring write() calls."
    );
    setTimeout(callback, 0);
    return true;
  }

  // Difference from Node.js -
  // In Node.js, we would also check at this point if a socket exists and is not corked.
  // If so, we'd cork the socket and then queue up an 'uncork' for the next tick.
  // In our implementation we do the same for "written data buffer"
  if (
    !fromEnd &&
    msg._writtenDataBuffer != null &&
    !msg._writtenDataBuffer.writableCorked
  ) {
    debug("msg._writtenDataBuffer.cork()");
    msg._writtenDataBuffer.cork();
    setTimeout(connectionCorkNT, 0, msg._writtenDataBuffer);
  }

  let ret;
  if (msg.chunkedEncoding && chunk.length !== 0) {
    msg._send(len.toString(16), "latin1", undefined);
    msg._send(crlf_buf, undefined, undefined);
    msg._send(chunk, encoding, undefined);
    ret = msg._send(crlf_buf, undefined, callback);
  } else {
    ret = msg._send(chunk, encoding, callback);
  }

  debug("write ret = " + ret);
  return ret;
}

function connectionCorkNT(dataBuffer: WrittenDataBuffer) {
  dataBuffer.uncork();
}

function onFinish(outmsg: FetchOutgoingMessage) {
  // Difference from Node.js -
  // In Node.js, if a socket exists and already had an error, we would simply return.
  outmsg.emit("finish");
}

// Override some properties this way, because TypeScript won't let us override
// properties with accessors.
Object.defineProperties(FetchOutgoingMessage.prototype, {
  writableFinished: {
    get() {
      // Difference from Node.js -
      // In Node.js, there is one additional requirement --
      //   there must be no underlying socket (or its writableLength must be 0).
      // In this implementation we will do the same against "written data buffer".
      return (
        this.finished &&
        this.outputSize === 0 &&
        (this._writtenDataBuffer == null ||
          this._writtenDataBuffer.writableLength === 0)
      );
    },
  },
  writableObjectMode: {
    get() {
      return false;
    },
  },
  writableLength: {
    get() {
      // Difference from Node.js -
      // In Node.js, if a socket exists then that socket's writableLength is added to
      // this value.
      // In this implementation we will do the same against "written data buffer".
      return (
        this.outputSize +
        (this._writtenDataBuffer != null
          ? this._writtenDataBuffer.writableLength
          : 0)
      );
    },
  },
  writableHighWaterMark: {
    get() {
      // Difference from Node.js -
      // In Node.js, if a socket exists then that socket's writableHighWaterMark is added to
      // this value.
      // In this implementation we will do the same against "written data buffer".
      return (
        HIGH_WATER_MARK +
        (this._writtenDataBuffer != null
          ? this._writtenDataBuffer.writableHighWaterMark
          : 0)
      );
    },
  },
  writableCorked: {
    get() {
      // Difference from Node.js -
      // In Node.js, if a socket exists then that socket's writableCorked is added to
      // this value.
      // In this implementation we will do the same against "written data buffer".
      return (
        this[kCorked] +
        (this._writtenDataBuffer != null
          ? this._writtenDataBuffer.writableCorked
          : 0)
      );
    },
  },
  writableEnded: {
    get() {
      return this.finished;
    },
  },
  writableNeedDrain: {
    get() {
      return !this.destroyed && !this.finished && this[kNeedDrain];
    },
  },
});
