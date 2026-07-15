import test from "node:test";
import assert from "node:assert/strict";

import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("splitRawArgumentString preserves backslashes in an unquoted Windows path", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd C:\Users\me\repo`), [
    "--cwd",
    String.raw`C:\Users\me\repo`
  ]);
});

test("splitRawArgumentString preserves a quoted Windows path with spaces", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd "C:\Program Files\App"`), [
    "--cwd",
    String.raw`C:\Program Files\App`
  ]);
});

test("splitRawArgumentString closes a quoted Windows path after a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd "C:\Program Files\Repo\" --write`), [
    "--cwd",
    "C:\\Program Files\\Repo\\",
    "--write"
  ]);
});

test("splitRawArgumentString closes a final quoted Windows path after a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`--cwd "C:\Program Files\Repo\"`), [
    "--cwd",
    "C:\\Program Files\\Repo\\"
  ]);
});

test("splitRawArgumentString accepts an escaped quote inside double quotes", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"say \"hello\""`), ['say "hello"']);
});

test("splitRawArgumentString preserves an escaped quote before a non-boundary character", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`"say \"hi\"..."`), ['say "hi"...']);
});

test("splitRawArgumentString collapses an escaped backslash", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`C:\\repo`), [String.raw`C:\repo`]);
});

test("splitRawArgumentString preserves a trailing backslash", () => {
  assert.deepEqual(splitRawArgumentString("--cwd C:\\repo\\"), ["--cwd", "C:\\repo\\"]);
});
