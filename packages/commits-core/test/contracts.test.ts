import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { format } from "node:util";
import {
  fullCommit,
  locationFromSearch,
  locationSearch,
  patchPresentation,
  readingLocation,
  structuredPatchSafe,
  READER_LIMITS,
} from "@jpahd/commits-core/contracts";

const sha = (digit: string, length = 40) => digit.repeat(length);

describe("portable commits contracts", () => {
  test("round-trips ref, pinned anchor, exact path, and independent selected commit", () => {
    const location = {
      ref: "refs/heads/feature/a+b & café",
      anchor: sha("a"),
      path: "src/a+b & café?#%.ts",
      commit: sha("b", 64),
    };
    assert.deepStrictEqual(locationFromSearch(locationSearch(location)), location);
    assert.deepStrictEqual(locationFromSearch(`?${locationSearch(location)}`), location);
    assert.strictEqual(Object.isFrozen(locationFromSearch(locationSearch(location))), true);
  });

  test("preserves an explicitly empty path and defaults only an absent ref", () => {
    assert.deepStrictEqual(locationFromSearch(""), { ref: "HEAD" });
    assert.deepStrictEqual(locationFromSearch(locationSearch({ ref: "HEAD", path: "" })), {
      ref: "HEAD",
      path: "",
    });
    assert.strictEqual(locationFromSearch("ref=HEAD").path, undefined);
    assert.throws(() => locationFromSearch("ref="));
  });

  test("accepts only complete lowercase SHA-1 or SHA-256 object IDs", () => {
    for (const length of [40, 64])
      assert.strictEqual(fullCommit(sha("a", length)), sha("a", length));
    for (const value of [
      "",
      "abc1234",
      sha("a", 39),
      sha("a", 41),
      sha("a", 63),
      sha("a", 65),
      sha("A"),
      sha("g"),
    ]) {
      assert.throws(() => fullCommit(value));
      assert.throws(() => locationFromSearch(`ref=HEAD&anchor=${value}`));
      assert.throws(() => locationFromSearch(`ref=HEAD&commit=${value}`));
    }
  });

  test("validates locations without normalizing an exact path", () => {
    const location = { ref: "HEAD", path: "./a/../b\\name\nfile" };
    assert.deepStrictEqual(readingLocation(location), location);
    for (const ref of ["", "a\0b", "a\nb", "a\rb", "x".repeat(1025)])
      assert.throws(() => locationSearch({ ref }));
    for (const path of ["a\0b", "x".repeat(4097)])
      assert.throws(() => locationSearch({ ref: "HEAD", path }));
    assert.doesNotThrow(() => readingLocation({ ref: "HEAD", path: "x".repeat(4096) }));
  });

  test("leaves empty and in-budget patch presentations unchanged", () => {
    for (const raw of [
      "",
      "diff --git a/a b/a\n+line\n",
      "x".repeat(READER_LIMITS.renderPatchBytes),
    ]) {
      assert.deepStrictEqual(patchPresentation(raw), { text: raw, clipped: false });
    }
    const exactLines = Array(READER_LIMITS.renderPatchLines).fill("x").join("\n");
    assert.deepStrictEqual(patchPresentation(exactLines), { text: exactLines, clipped: false });
  });

  test("clips presentation bytes separately from the retained raw patch", () => {
    const raw = "x".repeat(READER_LIMITS.renderPatchBytes + 17);
    const shown = patchPresentation(raw);
    assert.strictEqual(shown.clipped, true);
    assert.strictEqual(raw.startsWith(shown.text), true);
    assert.strictEqual(raw.endsWith(shown.tail!), true);
    assert.strictEqual(
      new TextEncoder().encode(shown.text + shown.tail!).length,
      READER_LIMITS.renderPatchBytes,
    );
    assert.strictEqual(raw.length, READER_LIMITS.renderPatchBytes + 17);
    const unicode = "é".repeat(READER_LIMITS.renderPatchBytes / 2 + 1);
    const presented = patchPresentation(unicode);
    assert.strictEqual(presented.clipped, true);
    assert.ok(
      new TextEncoder().encode(presented.text + presented.tail!).length <=
        READER_LIMITS.renderPatchBytes,
    );
  });

  test("bounds paired-word work before the structured renderer allocates an LCS matrix", () => {
    const before = "old ".repeat(30_000),
      after = "new ".repeat(30_000);
    assert.strictEqual(structuredPatchSafe(`-${before}\n+${after}`), false);
    assert.strictEqual(structuredPatchSafe("-old text\n+new text"), true);
    assert.strictEqual(structuredPatchSafe(`-${before}\n+${before}`), true);
    assert.strictEqual(
      structuredPatchSafe("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new"),
      true,
    );
    const manyPairs = Array.from(
      { length: 800 },
      () => `-${"old ".repeat(16)}\n+${"new ".repeat(16)}\n context`,
    ).join("\n");
    assert.strictEqual(structuredPatchSafe(manyPairs), false);
  });

  test("does not invent a replacement character when byte clipping splits a UTF-8 sequence", () => {
    const raw = "x".repeat(READER_LIMITS.renderPatchBytes - 1) + "🙂tail";
    const shown = patchPresentation(raw);
    assert.strictEqual(shown.clipped, true);
    assert.ok(!shown.text.includes("�"));
    assert.strictEqual(raw.startsWith(shown.text), true);
  });

  test("retains backend endings as separate literal evidence without enlarging display budgets", () => {
    const marker = "\n… (4 more file(s) truncated)\n<literal-not-markup>";
    const raw = "+ordinary line\n".repeat(40_000) + marker;
    const shown = patchPresentation(raw);
    assert.ok(!shown.text.includes(marker));
    assert.ok(shown.tail !== undefined);
    assert.ok(shown.tail.includes(marker));
    assert.strictEqual(raw.endsWith(shown.tail!), true);
    assert.ok(
      new TextEncoder().encode(shown.text + shown.tail!).length <= READER_LIMITS.renderPatchBytes,
    );
    assert.ok(
      shown.text.split("\n").length + shown.tail!.split("\n").length <=
        READER_LIMITS.renderPatchLines,
    );
    const unicode = "🙂".repeat(80_000) + "end";
    const tail = patchPresentation(unicode).tail!;
    assert.ok(!tail.includes("�"));
    assert.strictEqual(unicode.endsWith(tail), true);
  });

  for (const ending of ["\r", "\r\n", "\n"]) {
    test(
      format("counts renderer line boundaries for %j without changing literal endings", ending),
      () => {
        const raw = Array(80_001).fill("+").join(ending);
        assert.ok(new TextEncoder().encode(raw).length < READER_LIMITS.renderPatchBytes);
        const shown = patchPresentation(raw);
        assert.strictEqual(shown.clipped, true);
        assert.strictEqual(raw.startsWith(shown.text), true);
        assert.strictEqual(raw.endsWith(shown.tail!), true);
        assert.ok(
          shown.text.split(/\r\n|\r|\n/).length + shown.tail!.split(/\r\n|\r|\n/).length <=
            READER_LIMITS.renderPatchLines,
        );
        assert.ok(
          new TextEncoder().encode(shown.text).length +
            new TextEncoder().encode(shown.tail!).length <=
            READER_LIMITS.renderPatchBytes,
        );
      },
    );
  }

  for (const ending of ["\r", "\r\n", "\n"]) {
    test(format("LCS preflight follows renderer boundaries for %j", ending), () => {
      assert.strictEqual(
        structuredPatchSafe(`-${"old ".repeat(200)}${ending}+${"new ".repeat(200)}`),
        false,
      );
      assert.strictEqual(structuredPatchSafe(`-old text${ending}+new text`), true);
    });
  }

  test("line clipping preserves mixed CRLF, CR and LF bytes rather than rejoining lines", () => {
    const raw = "+é\r\n+中\r+🙂\n".repeat(2_000);
    const shown = patchPresentation(raw);
    assert.strictEqual(shown.clipped, true);
    assert.strictEqual(raw.startsWith(shown.text), true);
    assert.strictEqual(raw.endsWith(shown.tail!), true);
    assert.ok(shown.text.includes("+é\r\n+中\r+🙂\n"));
    assert.ok(shown.tail !== undefined);
    assert.ok(shown.tail.includes("+é\r\n+中\r+🙂\n"));
    assert.ok(
      shown.text.split(/\r\n|\r|\n/).length + shown.tail!.split(/\r\n|\r|\n/).length <=
        READER_LIMITS.renderPatchLines,
    );
  });

  test("presentation properties hold across seeded UTF-8 and CR/LF combinations", () => {
    const encoder = new TextEncoder();
    const lineCount = (value: string) => value.split(/\r\n|\r|\n/).length;
    const assertPresentation = (raw: string) => {
      const shown = patchPresentation(raw);
      const expectedClipped =
        encoder.encode(raw).length > READER_LIMITS.renderPatchBytes ||
        lineCount(raw) > READER_LIMITS.renderPatchLines;
      assert.strictEqual(shown.clipped, expectedClipped);
      assert.strictEqual(raw.startsWith(shown.text), true);
      assert.ok(
        encoder.encode(shown.text).length +
          (shown.tail === undefined ? 0 : encoder.encode(shown.tail).length) <=
          READER_LIMITS.renderPatchBytes,
      );
      assert.ok(
        lineCount(shown.text) + (shown.tail === undefined ? 0 : lineCount(shown.tail)) <=
          READER_LIMITS.renderPatchLines,
      );
      const cuts = [shown.text.length];
      if (shown.tail === undefined) assert.strictEqual(shown.text, raw);
      else {
        assert.strictEqual(raw.endsWith(shown.tail), true);
        cuts.push(raw.length - shown.tail.length);
      }
      for (const cut of cuts) {
        assert.strictEqual(raw[cut - 1] === "\r" && raw[cut] === "\n", false);
        assert.strictEqual(
          /[\uD800-\uDBFF]/.test(raw[cut - 1] ?? "") && /[\uDC00-\uDFFF]/.test(raw[cut] ?? ""),
          false,
        );
      }
    };
    const prefixBytes = READER_LIMITS.renderPatchBytes - 4096;
    for (const ending of ["\r", "\n", "\r\n", "\r\n\r", "\n\r\n"]) {
      for (const lines of [0, 1, 3_999, 4_000, 4_001, 80_000]) {
        assertPresentation(Array(lines).fill("é").join(ending));
        assertPresentation(Array(lines).fill("🙂").join(ending) + ending);
      }
    }
    // Force CRLF and UTF-8 sequences across both byte clipping boundaries.
    for (const token of ["\r\n", "é", "中", "🙂", "\uFEFF", "\uD800", "\uDC00"]) {
      for (let shift = 0; shift < 4; shift++) {
        assertPresentation(
          "\uFEFF" + "x".repeat(prefixBytes - 4 + shift) + token + "y".repeat(8192),
        );
        assertPresentation(
          "x".repeat(READER_LIMITS.renderPatchBytes) + token + "y".repeat(4093 + shift),
        );
      }
    }
    let seed = 0x5eed1234;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const words = ["a", "é", "中", "🙂", "\uFEFF", "<literal>"];
    const endings = ["\r", "\n", "\r\n", "", "\r\r\n"];
    for (let trial = 0; trial < 96; trial++) {
      const block = Array.from(
        { length: 8 },
        () => words[next() % words.length] + endings[next() % endings.length],
      ).join("");
      assertPresentation(block.repeat(1 + (next() % 14_000)));
    }
  });

  test("clips excess lines even when byte count is small", () => {
    const raw = Array(READER_LIMITS.renderPatchLines + 1)
      .fill("line")
      .join("\n");
    const presented = patchPresentation(raw);
    assert.strictEqual(presented.clipped, true);
    assert.ok(
      presented.text.split("\n").length + presented.tail!.split("\n").length <=
        READER_LIMITS.renderPatchLines,
    );
    assert.strictEqual(raw.startsWith(presented.text), true);
    assert.strictEqual(raw.endsWith(presented.tail!), true);
  });
});
