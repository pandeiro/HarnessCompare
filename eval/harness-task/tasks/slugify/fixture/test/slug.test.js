import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("basic words and punctuation", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("collapses separators and trims", () => {
  assert.equal(slugify("  A -- B  "), "a-b");
});

test("custom separator", () => {
  assert.equal(slugify("Hello World", { separator: "_" }), "hello_world");
});

test("removes diacritics", () => {
  assert.equal(slugify("Café Déjà Vu"), "cafe-deja-vu");
});

test("maxLength cuts at a word boundary", () => {
  assert.equal(slugify("alpha beta gamma", { maxLength: 12 }), "alpha-beta");
});

test("empty input", () => {
  assert.equal(slugify("  "), "");
});
