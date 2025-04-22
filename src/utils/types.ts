/*
 * Copyright Michael Hart
 * Licensed under the MIT license. See LICENSE file for details.
 *
 * Portions of this file Copyright Fastly, Inc. See LICENSE file for details.
 * Portions of this file Copyright Joyent, Inc. and other Node contributors. See LICENSE file for details.
 */

import { ERR_INVALID_ARG_TYPE } from "./errors.js";

/* These items copied from Node.js: node/lib/internal/validators.js */

export function validateString(value: any, name: string) {
  if (typeof value !== "string")
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

/* These items copied from Node.js: node/lib/internal/util/types.js */

export function isUint8Array(value: any) {
  return value != null && value[Symbol.toStringTag] === "Uint8Array";
}
