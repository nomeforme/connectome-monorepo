// @ts-check
/* mcpl-web/test/terms.test.mjs — what the board's hello says about itself
 * (retention, the operator's terms pointer) rides on every room descriptor
 * the host is told about; the seat accepts the board's terms only at the
 * exact version the keeper set in WEB_BOARD_ACCEPT_TERMS, and otherwise
 * says once, in its log, what consent is needed. Fixtures only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { boot } from "./lib/boot.mjs";
import { createFakeBoard, ROOMS, waitFor } from "./lib/fake-board.mjs";

const GENERAL = ROOMS[0].id;
const TERMS = { url: "https://terms.example/board", version: "2026-10", summary: "Be kind." };

async function setup(t, env = {}) {
  const board = await createFakeBoard({ terms: TERMS, retentionDays: 90 });
  const seat = await boot(board, { env });
  t.after(async () => {
    await seat.close();
    await board.close();
  });
  return { board, seat };
}

test("room descriptors carry the board's retention and terms pointer", async (t) => {
  const { seat } = await setup(t);
  const d = await waitFor(() => seat.channels.get(GENERAL));
  assert.equal(d.metadata.retentionDays, 90);
  assert.deepEqual(d.metadata.terms, TERMS);
});

test("with the keeper's matching version the seat accepts the terms", async (t) => {
  const { board, seat } = await setup(t, { WEB_BOARD_ACCEPT_TERMS: "2026-10" });
  await waitFor(() => board.state.accepted.size === 1);
  assert.ok([...board.state.accepted][0].endsWith("@2026-10"));
  await waitFor(() => seat.logs.some((l) => l.includes("accepted the board's terms, version 2026-10")));
});

test("without consent (or for another version) the seat never accepts, and says so once", async (t) => {
  const { board, seat } = await setup(t, { WEB_BOARD_ACCEPT_TERMS: "2025-01" });
  await waitFor(() => seat.logs.some((l) => l.includes("set WEB_BOARD_ACCEPT_TERMS=2026-10")));
  assert.equal(board.state.accepted.size, 0);
  assert.equal(board.state.received.filter((m) => m.type === "accept_terms").length, 0);
});
