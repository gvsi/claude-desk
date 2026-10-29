// spa_rewrite.js as CloudFront runs it: the cloudfront-js-2.0 runtime loads the file as a plain
// script, not a module, and calls its global `handler` with the viewer request event.
// Run with `node --test 'functions/**/*.test.mjs'` from infra/ (make infra-check does).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./spa_rewrite.js", import.meta.url), "utf8");

function viewerRequest(uri) {
  return {
    method: "GET",
    uri,
    querystring: { lang: { value: "es" } },
    headers: { host: { value: "d111111abcdef8.cloudfront.net" } },
    cookies: {},
  };
}

function handle(request) {
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: "spa_rewrite.js" });
  return context.handler({
    version: "1.0",
    context: { eventType: "viewer-request" },
    viewer: { ip: "192.0.2.1" },
    request,
  });
}

test("routes_to_index", () => {
  for (const uri of ["/", "/d/rivera-plumbing-abc123", "/pay/tok", "/d/rivera-plumbing-abc123/"]) {
    const result = handle(viewerRequest(uri));
    // Only the path changes: the query string and headers reach the app as sent.
    assert.deepEqual(result, { ...viewerRequest(uri), uri: "/index.html" }, uri);
  }
});

test("keeps_files", () => {
  for (const uri of ["/assets/app-1a2b.js", "/favicon.svg", "/index.html"]) {
    assert.deepEqual(handle(viewerRequest(uri)), viewerRequest(uri), uri);
  }
});
