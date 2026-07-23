// core/api.ts — the HTTP client, and specifically its cold-start retry.
//
// The backend scales to zero, so the FIRST request of a session routinely hits
// a machine that is still waking: 5xx, or a dropped connection. Retrying those
// is what keeps the app on its loading screen instead of dead-ending. Retrying
// a 4xx would be wrong — that's a real answer, and repeating it just delays the
// error the user needs to see.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  castVote,
  deleteTune,
  getTunes,
  markPlayed,
  randomizeKey,
  recordPick,
  undoVote,
} from "../api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number) =>
  ({ ok: false, status, text: async () => "boom" }) as Response;

/** Run `fn`, auto-advancing fake timers so retry backoff doesn't really sleep. */
async function withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const p = fn();
  // Mark it handled up front: a rejection lands while the timers are being
  // advanced below, which is before the caller's `.rejects` assertion attaches.
  // Adding a handler doesn't consume the rejection — the caller still sees it.
  p.catch(() => {});
  await vi.runAllTimersAsync();
  return p;
}

describe("getTunes", () => {
  it("returns the payload on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([{ id: "t1" }])));
    expect(await getTunes()).toEqual([{ id: "t1" }]);
  });

  it("retries a 5xx and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(502))
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValue(ok([{ id: "t1" }]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await withoutWaiting(getTunes)).toEqual([{ id: "t1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a dropped connection (no status at all)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(ok([]));
    vi.stubGlobal("fetch", fetchMock);

    await withoutWaiting(getTunes);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429])("retries %i", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(status)).mockResolvedValue(ok([]));
    vi.stubGlobal("fetch", fetchMock);
    await withoutWaiting(getTunes);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 404 — that is a real answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getTunes()).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget rather than looping forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(502));
    vi.stubGlobal("fetch", fetchMock);
    await expect(withoutWaiting(getTunes)).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(7); // first try + 6 backoff delays
  });
});

describe("error shape", () => {
  it("carries the status code so callers can branch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(403)));
    const err = await recordPick("t1").catch((e) => e);
    expect(err.status).toBe(403);
  });
});

describe("request shapes", () => {
  it("posts a pick", async () => {
    const f = vi.fn().mockResolvedValue(ok({}));
    vi.stubGlobal("fetch", f);
    await recordPick("t1");
    expect(f).toHaveBeenCalledWith("/api/tunes/t1/pick", expect.objectContaining({ method: "POST" }));
  });

  it("sends the key when marking played, and null when omitted", async () => {
    const f = vi.fn().mockResolvedValue(ok({}));
    vi.stubGlobal("fetch", f);
    await markPlayed("t1", "Eb");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ key: "Eb" });
    await markPlayed("t1");
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ key: null });
  });

  it("posts a key randomization", async () => {
    const f = vi.fn().mockResolvedValue(ok({ key: "F" }));
    vi.stubGlobal("fetch", f);
    expect(await randomizeKey("t1")).toEqual({ key: "F" });
  });

  it("bundles a vote and the anonymous id into one body", async () => {
    const f = vi.fn().mockResolvedValue(ok({ tune: {}, rating_id: "r1" }));
    vi.stubGlobal("fetch", f);
    await castVote("t1", { liked: true, obscurity: 70 }, "anon-9");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
      liked: true,
      obscurity: 70,
      anonymous_user_id: "anon-9",
    });
  });

  it("deletes a tune and a rating", async () => {
    const f = vi.fn().mockResolvedValue(ok({ ok: true }));
    vi.stubGlobal("fetch", f);
    await deleteTune("t1");
    await undoVote("r1");
    expect(f.mock.calls[0][0]).toBe("/api/tunes/t1");
    expect(f.mock.calls[0][1].method).toBe("DELETE");
    expect(f.mock.calls[1][0]).toBe("/api/ratings/r1");
  });
});
