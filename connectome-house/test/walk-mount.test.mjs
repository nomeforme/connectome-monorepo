// @ts-check
/* connectome-house/test/walk-mount.test.mjs — pins for the shared
 * tool-mount contract (src/walk-mount.mjs), ported verbatim from the
 * reference harness's walk-mount.test.mjs — the module itself is
 * unchanged, generic infrastructure, no archive vocabulary to drop. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressIf, defsIf, mountIfCapable } from "../src/walk-mount.mjs";

test("mountIfCapable: null probe calls the factory directly (self-probing modules)", async () => {
  let called = 0;
  const tools = await mountIfCapable(null, () => {
    called++;
    return { definitions: ["x"] };
  });
  assert.equal(called, 1);
  assert.deepEqual(tools, { definitions: ["x"] });
});

test("mountIfCapable: a factory that self-reports incapacity (returns null) mounts null", async () => {
  const tools = await mountIfCapable(null, () => null);
  assert.equal(tools, null);
});

test("mountIfCapable: sync probe true -> factory runs", async () => {
  const tools = await mountIfCapable(
    () => true,
    () => ({ definitions: [] }),
  );
  assert.deepEqual(tools, { definitions: [] });
});

test("mountIfCapable: sync probe false -> factory never runs, mounts null", async () => {
  let called = 0;
  const tools = await mountIfCapable(
    () => false,
    () => {
      called++;
      return {};
    },
  );
  assert.equal(tools, null);
  assert.equal(called, 0, "the factory must not run when the probe fails");
});

test("mountIfCapable: async probe (existsSync-style check wrapped async) gates correctly", async () => {
  const probeTrue = async () => true;
  const probeFalse = async () => false;
  assert.deepEqual(await mountIfCapable(probeTrue, () => ({ ok: 1 })), { ok: 1 });
  assert.equal(await mountIfCapable(probeFalse, () => ({ ok: 1 })), null);
});

test("defsIf: mounted tools contribute their definitions array", () => {
  const tools = { definitions: ["media_list", "media_attach"] };
  assert.deepEqual(defsIf(tools), ["media_list", "media_attach"]);
});

test("defsIf: unmounted (null) contributes nothing", () => {
  assert.deepEqual(defsIf(null), []);
});

test("addressIf: mounted + a static address override", () => {
  const tools = { definitions: [] };
  assert.deepEqual(addressIf(tools, "## Static Address"), ["## Static Address"]);
});

test("addressIf: mounted, no override -> reads the module's own composed .address", () => {
  const tools = { address: "## The atelier\n\nforms: ascii-frames" };
  assert.deepEqual(addressIf(tools), ["## The atelier\n\nforms: ascii-frames"]);
});

test("addressIf: unmounted (null) never names the affordance, override or not", () => {
  assert.deepEqual(addressIf(null, "## Static Address"), []);
  assert.deepEqual(addressIf(null), []);
});
