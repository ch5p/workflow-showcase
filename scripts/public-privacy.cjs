"use strict";

// Compressed media can accidentally form short email-like byte runs; keep binary checks to high-confidence signatures.
const FORBIDDEN_BINARY_CONTENT = [
  { label: "Windows user path", pattern: /[A-Za-z]:[\\/]+Users[\\/]+/i },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
];

function assertNoPrivateBinaryContent(bytes, label = "public file"){
  if(!Buffer.isBuffer(bytes)) throw new TypeError("Public privacy scan requires a Buffer");
  const views = [
    bytes.toString("latin1"),
    bytes.length > 1 ? bytes.toString("utf16le") : "",
    bytes.length > 2 ? bytes.subarray(1).toString("utf16le") : "",
  ];
  for(const rule of FORBIDDEN_BINARY_CONTENT){
    if(!views.some(content => rule.pattern.test(content))) continue;
    const error = new Error(rule.label + " found in " + label);
    error.code = "PUBLIC_PRIVATE_DATA";
    throw error;
  }
}

module.exports = { FORBIDDEN_BINARY_CONTENT, assertNoPrivateBinaryContent };
