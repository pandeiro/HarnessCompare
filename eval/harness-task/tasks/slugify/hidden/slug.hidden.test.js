import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("hidden: diacritics are transliterated", () => {
  assert.equal(slugify("Café Déjà Vu"), "cafe-deja-vu");
});

test("hidden: non-Latin letters are preserved", () => {
  assert.equal(slugify("東京 Station"), "東京-station");
});

test("hidden: punctuation and underscores collapse", () => {
  assert.equal(slugify("A_B / C"), "a-b-c");
});

test("hidden: custom separator with regex metacharacter", () => {
  assert.equal(slugify("a...b", { separator: "." }), "a.b");
});

test("hidden: empty and separator-only inputs", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("---"), "");
});

test("hidden: maxLength hard-cuts a long word", () => {
  assert.equal(slugify("abcdefghij", { maxLength: 5 }), "abcde");
});

test("hidden: maxLength cuts at the last separator", () => {
  assert.equal(slugify("alpha beta gamma", { maxLength: 12 }), "alpha-beta");
});

test("hidden: maxLength removes a trailing separator", () => {
  assert.equal(slugify("alpha beta", { maxLength: 6 }), "alpha");
});

test("hidden: maxLength of one", () => {
  assert.equal(slugify("alpha beta", { maxLength: 1 }), "a");
});

test("hidden: invalid separators throw TypeError", () => {
  assert.throws(() => slugify("hello", { separator: "" }), TypeError);
  assert.throws(() => slugify("hello", { separator: 5 }), TypeError);
});

test("hidden: invalid maxLength throws TypeError", () => {
  assert.throws(() => slugify("hello", { maxLength: 0 }), TypeError);
  assert.throws(() => slugify("hello", { maxLength: -1 }), TypeError);
  assert.throws(() => slugify("hello", { maxLength: 1.5 }), TypeError);
});

test("hidden: mixed digits and diacritics", () => {
  assert.equal(slugify("Version 2.0 — Café"), "version-2-0-cafe");
});
