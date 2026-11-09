# Slug API

`slugify(input, options)` returns a URL-safe slug.

## Rules

1. Convert `input` to a string. Normalize it to Unicode NFKD and remove combining marks.
2. Lowercase the result.
3. Keep Unicode letters (`\p{L}`) and numbers (`\p{N}`). Replace every run of other characters with `options.separator`.
4. Collapse repeated separators and trim leading and trailing separators.
5. If `options.maxLength` is a positive integer, truncate the slug to at most that many characters. When the limit falls inside a word, cut at the last separator within the limit if one exists after position 0; otherwise hard-cut. Remove a trailing separator left by the truncation.
6. Empty input, or input containing no letters or numbers, returns `""`.
7. `options.separator` defaults to `"-"`. It must be a non-empty string; otherwise throw `TypeError`.
8. When provided, `options.maxLength` must be a positive integer; otherwise throw `TypeError`.

## Examples

| Input | Options | Result |
| --- | --- | --- |
| `Hello, World!` | — | `hello-world` |
| `Café Déjà Vu` | — | `cafe-deja-vu` |
| `東京 Station` | — | `東京-station` |
| `alpha beta gamma` | `{ maxLength: 12 }` | `alpha-beta` |
| `abcdefghij` | `{ maxLength: 5 }` | `abcde` |
