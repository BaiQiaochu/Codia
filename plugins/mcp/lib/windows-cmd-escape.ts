/*!
 * cmd metacharacter escaping and the extra npm-shim layer are adapted from
 * cross-spawn 7.0.6, lib/util/escape.js and lib/parse.js:
 * https://github.com/moxystudio/node-cross-spawn/tree/v7.0.6
 * The CRT argument encoder below uses a linear scan of backslash runs.
 *
 * The MIT License (MIT)
 * Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
const NPM_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

function assertBatchValue(value: string): void {
  if (/[\0\r\n]/u.test(value)) {
    throw new Error("Windows batch MCP commands and arguments cannot contain NUL or line breaks; use a native executable instead");
  }
}

function escapeMetaCharacters(value: string): string {
  return value.replace(CMD_META_CHARACTERS, "^$1");
}

// Microsoft CRT argv convention (not a claim about every Windows program):
// 2n+1 backslashes before an embedded quote, 2n before the closing quote.
// https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
function quoteCrtArgument(value: string): string {
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    result += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes);
    result += character;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

export function buildWindowsCommandLine(command: string, args: string[]): string {
  assertBatchValue(command);
  const extraShimLayer = NPM_CMD_SHIM.test(command);
  const encodedArgs = args.map((argument) => {
    assertBatchValue(argument);
    const escaped = escapeMetaCharacters(quoteCrtArgument(argument));
    return extraShimLayer ? escapeMetaCharacters(escaped) : escaped;
  });
  // /s removes these outer quotes. The remaining command/arguments have their
  // own escaping, and must be passed with windowsVerbatimArguments: true.
  // Arbitrary batch scripts can still expand/reinterpret arguments internally.
  return `"${[escapeMetaCharacters(command), ...encodedArgs].join(" ")}"`;
}
