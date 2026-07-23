// core/notation.ts — the read-only notation client.
//
// Two things worth pinning. First, there is NO write path: charts come from the
// server's charts/ folder, so any reappearance of an upload/delete export is a
// regression. Second, the SVG fetch has a hard deadline — without one the UI sat
// on "Engraving…" forever when a Verovio segfault killed the worker, which is
// exactly what a crash looked like from the outside.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as notation from "../notation";
import {
  SVG_TIMEOUT_MS,
  fetchNotationSvg,
  getNotationIndex,
  getNotationMeta,
  notationMusicXmlUrl,
  notationSvgUrl,
} from "../notation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the module is read-only", () => {
  it("exports no upload or delete function", () => {
    // Charts are imported from a folder on the server; a write API reappearing
    // here would mean the folder-is-the-interface design was undone.
    for (const gone of ["transcribeChart", "importMusicXml", "deleteNotation"]) {
      expect(notation).not.toHaveProperty(gone);
    }
  });
});

describe("URL builders", () => {
  it("builds an SVG URL with key and width", () => {
    expect(notationSvgUrl("t1", "Eb")).toBe(
      "/api/chart/t1/notation.svg?key=Eb&width=2100",
    );
    expect(notationSvgUrl("t1", "Eb", 900)).toContain("width=900");
  });

  it("URL-encodes sharp keys — # would otherwise start a fragment", () => {
    const url = notationSvgUrl("t1", "C#");
    expect(url).toContain("key=C%23");
    expect(url).not.toContain("key=C#");
  });

  it("builds a MusicXML URL", () => {
    expect(notationMusicXmlUrl("t1", "F")).toBe(
      "/api/chart/t1/notation.musicxml?key=F",
    );
  });
});

describe("getNotationMeta", () => {
  it("pins the request to a specific chart when one is given", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", f);
    // Pinning matters: without it an import could attach to a page the user
    // never opened.
    await getNotationMeta("t1", { book: "The Real Book, Vol. 1", page: "A1" });
    expect(f.mock.calls[0][0]).toContain("book=The%20Real%20Book%2C%20Vol.%201");
    expect(f.mock.calls[0][0]).toContain("page=A1");
  });

  it("omits the query when no chart is given", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", f);
    await getNotationMeta("t1");
    expect(f.mock.calls[0][0]).toBe("/api/chart/t1/notation");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(getNotationMeta("t1")).rejects.toThrow(/500/);
  });
});

describe("getNotationIndex", () => {
  it("returns a set of tune ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ tunes: ["a", "b"] }),
    }));
    const ids = await getNotationIndex();
    expect(ids.has("a")).toBe(true);
    expect(ids.size).toBe(2);
  });

  it("returns an empty set when locked, rather than throwing", async () => {
    // The index is password-gated; a 401 must leave the UI merely without
    // transpose buttons, not broken.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect((await getNotationIndex()).size).toBe(0);
  });

  it("tolerates a body with no tunes field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect((await getNotationIndex()).size).toBe(0);
  });
});

describe("fetchNotationSvg", () => {
  it("returns the SVG text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, text: async () => "<svg/>",
    }));
    expect(await fetchNotationSvg("t1", "C")).toBe("<svg/>");
  });

  it("surfaces the server's error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: "that key is out of range" }),
    }));
    await expect(fetchNotationSvg("t1", "C")).rejects.toThrow(/out of range/);
  });

  it("falls back to the status when there is no error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 502, json: async () => { throw new Error("not json"); },
    }));
    await expect(fetchNotationSvg("t1", "C")).rejects.toThrow(/502/);
  });

  it("has a deadline, so a hung server shows an error not an eternal spinner", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
      ),
    );
    const p = fetchNotationSvg("t1", "C");
    const assertion = expect(p).rejects.toThrow(/didn.t come back/);
    await vi.advanceTimersByTimeAsync(SVG_TIMEOUT_MS + 1000);
    await assertion;
  });

  it("propagates a caller's own abort untouched", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
      ),
    );
    const p = fetchNotationSvg("t1", "C", 2100, ctrl.signal);
    ctrl.abort();
    // Not the timeout message — the caller cancelled deliberately (e.g. the
    // user switched keys), and that must not surface as a server error.
    await expect(p).rejects.toThrow(/aborted/);
  });
});
