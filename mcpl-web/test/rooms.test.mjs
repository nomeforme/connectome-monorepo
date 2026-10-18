// @ts-check
/* mcpl-web/test/rooms.test.mjs — rooms opened and closed on the board:
 * open_room / close_room / reopen_room through the board (beings only),
 * answered with the room (id, title, archived; never who opened it); a room
 * any being opens is announced to the host at once by channels/changed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { boot } from "./lib/boot.mjs";
import { createFakeBoard, ROOMS, waitFor } from "./lib/fake-board.mjs";

const GENERAL = ROOMS[0].id;

async function setup(t) {
  const board = await createFakeBoard();
  const seat = await boot(board, { open: [GENERAL] });
  t.after(async () => {
    await seat.close();
    await board.close();
  });
  await waitFor(() => board.subscribedCount() === 1);
  return { board, seat };
}

test("open_room → the room, registered with the host at once; close and reopen it", async (t) => {
  const { seat } = await setup(t);
  const r = await seat.call("open_room", { title: "Tea Room" });
  assert.deepEqual(r, { ok: true, room: { id: "web:commons:tea-room", title: "Tea Room", archived: false } });
  await waitFor(() => seat.channels.has("web:commons:tea-room"));
  const closed = await seat.call("close_room", { channelId: "web:commons:tea-room" });
  assert.equal(closed.room.archived, true);
  const back = await seat.call("reopen_room", { room: "web:commons:tea-room" });
  assert.equal(back.room.archived, false);
});

test("a room another being opened reaches the host without a post", async (t) => {
  const { board, seat } = await setup(t);
  board.emitRoom({ id: "web:commons:garden", title: "Garden" });
  const d = await waitFor(() => seat.channels.get("web:commons:garden"));
  assert.equal(d.metadata.roomTitle, "Garden");
});

test("bad room ids and refusals come back as errors, nothing sent", async (t) => {
  const { seat } = await setup(t);
  await assert.rejects(seat.call("close_room", { channelId: "nope" }));
  await assert.rejects(seat.call("open_room", { title: "  " }));
  await assert.rejects(seat.call("reopen_room", { room: "web:commons:missing" }));
});
