/**
 * A redirect must never carry a credential to a different origin.
 *
 * Two independent implementations had the same hole, so both are pinned here.
 *
 *   1. `EgressProxy` compared `hostname`, while its own comment said "origin".
 *      `https://host` -> `http://host` kept the Authorization header and put it
 *      on the wire in clear text; `:443` -> `:8080` kept it too. Same hostname,
 *      different origin, both times.
 *   2. The inference path called the global `fetch` with the default
 *      `redirect: "follow"`. The platform strips `Authorization` across origins
 *      and does NOT strip `x-api-key`, which is how Anthropic authenticates —
 *      so a 302 from an inference endpoint handed the key to whoever it named.
 *
 * Real loopback servers, because the whole defect lives in what an actual
 * redirect does to actual headers.
 *
 * `Bun.fetch` rather than the global one throughout: dozens of sibling test
 * files replace `globalThis.fetch` with a stub, Bun runs the suite in one
 * process, and a stub left behind by whoever ran before us would make these
 * tests measure that stub instead of a redirect. The global is also pinned for
 * the duration of this file, because the inference path under test calls it by
 * name and cannot be injected.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { postJson } from "../src/egress/inference-providers.ts";
import type { ToolManifest } from "../src/types.ts";

/** Headers the last request to each server arrived with. */
const seen: Record<string, Record<string, string>> = {};

function record(name: string, req: Request) {
  const h: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    h[k.toLowerCase()] = v;
  });
  seen[name] = h;
}

let target: ReturnType<typeof Bun.serve>;
let redirector: ReturnType<typeof Bun.serve>;
let stubbedFetch: typeof globalThis.fetch;

beforeAll(() => {
  stubbedFetch = globalThis.fetch;
  globalThis.fetch = Bun.fetch as typeof globalThis.fetch;
  // The destination a redirect points at. Never legitimately given a key.
  target = Bun.serve({
    port: 0,
    fetch(req) {
      record("target", req);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  // Same host as `target` would be if we only compared hostnames: both are
  // 127.0.0.1, and only the PORT differs. That is the point of the test.
  redirector = Bun.serve({
    port: 0,
    fetch(req) {
      record("redirector", req);
      const url = new URL(req.url);
      if (url.pathname === "/same-origin-hop") {
        return new Response(null, { status: 302, headers: { location: "/landed" } });
      }
      if (url.pathname === "/landed") {
        return new Response(JSON.stringify({ ok: true, landed: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${target.port}/taken` },
      });
    },
  });
});

afterAll(() => {
  globalThis.fetch = stubbedFetch;
  target.stop(true);
  redirector.stop(true);
});

function manifest(): ToolManifest {
  return {
    name: "t",
    description: "t",
    permissions: ["net:fetch"],
    networkAccess: true,
    allowedDomains: ["127.0.0.1"],
    allowedPaths: [],
  } as unknown as ToolManifest;
}

describe("EgressProxy redirects", () => {
  test("a hop to a different PORT on the same host drops the credential", async () => {
    const proxy = new EgressProxy(
      (() => {}) as never,
      {
        maxRequests: 100,
        windowMs: 60_000,
        defaultTimeoutMs: 10_000,
        trustedLocalOrigins: [
          `http://127.0.0.1:${redirector.port}`,
          `http://127.0.0.1:${target.port}`,
        ],
        underlyingFetch: (u, i) => Bun.fetch(u, i),
        externalWriteBudget: 0,
        unattendedWriteDenyHosts: [],
        unattended: false,
        dryRunExternalWrites: false,
      } as never,
    );
    const f = proxy.forTool(manifest(), "session");
    await f(`http://127.0.0.1:${redirector.port}/leak`, {
      headers: { Authorization: "Bearer super-secret" },
    });

    expect(seen.redirector?.authorization).toBe("Bearer super-secret");
    expect(seen.target?.authorization).toBeUndefined();
  });

  test("a same-origin hop keeps the credential, so ordinary redirects still work", async () => {
    const proxy = new EgressProxy(
      (() => {}) as never,
      {
        maxRequests: 100,
        windowMs: 60_000,
        defaultTimeoutMs: 10_000,
        trustedLocalOrigins: [`http://127.0.0.1:${redirector.port}`],
        underlyingFetch: (u, i) => Bun.fetch(u, i),
        externalWriteBudget: 0,
        unattendedWriteDenyHosts: [],
        unattended: false,
        dryRunExternalWrites: false,
      } as never,
    );
    const f = proxy.forTool(manifest(), "session");
    const res = await f(`http://127.0.0.1:${redirector.port}/same-origin-hop`, {
      headers: { Authorization: "Bearer super-secret" },
    });

    expect(res.ok).toBe(true);
    expect(seen.redirector?.authorization).toBe("Bearer super-secret");
  });
});

describe("inference redirects", () => {
  test("an x-api-key is refused a cross-origin hop rather than carried", async () => {
    seen.target = {};
    await expect(
      postJson(
        `http://127.0.0.1:${redirector.port}/v1/messages`,
        { hello: "world" },
        { "x-api-key": "sk-ant-secret" },
      ),
    ).rejects.toThrow(/different server|Refusing to follow/i);

    // The header that no fetch implementation protects, and the whole reason
    // this guard is not left to the platform.
    expect(seen.target?.["x-api-key"]).toBeUndefined();
  });

  test("a same-origin hop is still followed, so path normalisation keeps working", async () => {
    const out = (await postJson(
      `http://127.0.0.1:${redirector.port}/same-origin-hop`,
      { hello: "world" },
      { "x-api-key": "sk-ant-secret" },
    )) as { landed?: boolean };

    expect(out.landed).toBe(true);
    expect(seen.redirector?.["x-api-key"]).toBe("sk-ant-secret");
  });
});
