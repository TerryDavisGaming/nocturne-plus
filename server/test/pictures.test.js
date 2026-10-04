// Pictures show at once (migration 0003 and the hourly catch-up): what the move changes and what it keeps, that
// the worker's own catch-up does exactly what the migration does, and that a hub nobody migrated heals itself.

import { assert, assertEquals } from "./assert.js";
import { FakeD1 } from "./fakes.js";
import { advance, fakeKey, makeHub, publish, register, seedPackages, time } from "./helpers.js";
import { goodBattle, thumbB64 } from "./make-fixtures.js";
import { pictureCatchUp } from "../src/cron.js";

const HOURLY = "7 * * * *";
const readMigration = (name) => Deno.readTextFile(new URL(`../migrations/${name}`, import.meta.url));
const MIGRATION = await readMigration("0003_pictures_at_once.sql");

const admin = (hub, method, path, json) => hub.call(method, "/v1/admin/" + path, { admin: true, json: method === "GET" ? undefined : json ?? {} });
const setDelay = async (hub, hours) => assertEquals((await admin(hub, "PUT", "settings", { picture_delay_hours: String(hours) })).status, 200);

/**
 * A hub as 2.9.0 left it: the seeded delay of 24, no marker, two waiting pictures, a refused one and a shown one.
 * The waiting ones are due in 5 hours, so the cron's own due check can't show them.
 */
async function oldHub(delay = "24") {
  const hub = await makeHub();
  const db = hub.d1.sqlite;
  seedPackages(hub, 4, (i) => ({ thumb: thumbB64(), picture: ["waiting", "waiting", "refused", "shown"][i] }));
  db.prepare("UPDATE packages SET picture_due = ? WHERE picture_state = 'waiting'").run(time() + 5 * 3600);
  db.prepare("UPDATE settings SET v = ? WHERE k = 'picture_delay_hours'").run(delay);
  db.prepare("DELETE FROM settings WHERE k = 'pictures_at_once'").run();
  return hub;
}

const snapshot = (hub) => ({
  delay: hub.d1.one("SELECT v FROM settings WHERE k = 'picture_delay_hours'")?.v ?? null,
  marker: hub.d1.one("SELECT v FROM settings WHERE k = 'pictures_at_once'")?.v ?? null,
  states: hub.d1.q("SELECT picture_state AS s FROM packages ORDER BY seq").map((r) => r.s),
  dues: hub.d1.q("SELECT picture_due AS d FROM packages ORDER BY seq").map((r) => r.d),
});

const viaMigration = async (hub) => void hub.d1.sqlite.exec(MIGRATION);
const viaCatchUp = async (hub) => void (await pictureCatchUp(hub.env()));

function scenarios() {
  const due = time() + 5 * 3600;
  const WAIT = ["waiting", "waiting", "refused", "shown"];
  const NONE = [null, null, null, null];
  return [
    {
      name: "the seeded 24 (nobody ever changed it): delay 0, waiting pictures shown, a refused one stays refused",
      prepare: async () => oldHub("24"),
      expected: { delay: "0", marker: "1", states: ["shown", "shown", "refused", "shown"], dues: NONE },
    },
    {
      name: "a waiting picture with no due time (held for the owner's OK, a key the owner refused) stays; the timed one is shown",
      prepare: async () => {
        const hub = await oldHub("24");
        hub.d1.sqlite.prepare("UPDATE packages SET picture_due = NULL WHERE seq = (SELECT min(seq) FROM packages WHERE picture_state = 'waiting')").run();
        return hub;
      },
      expected: { delay: "0", marker: "1", states: ["waiting", "shown", "refused", "shown"], dues: NONE },
    },
    {
      name: "the owner saved 24 on /admin (after 12): kept, and the waiting pictures keep waiting",
      prepare: async () => {
        const hub = await oldHub("24");
        await setDelay(hub, 12);
        await setDelay(hub, 24);
        return hub;
      },
      expected: { delay: "24", marker: "1", states: WAIT, dues: [due, due, null, null] },
    },
    {
      name: "the owner chose 6: kept, and the waiting pictures keep waiting",
      prepare: async () => oldHub("6"),
      expected: { delay: "6", marker: "1", states: WAIT, dues: [due, due, null, null] },
    },
    {
      name: "the owner already chose 0: kept, waiting pictures are shown",
      prepare: async () => oldHub("0"),
      expected: { delay: "0", marker: "1", states: ["shown", "shown", "refused", "shown"], dues: NONE },
    },
    {
      name: "no delay row at all (the code default is 0): waiting pictures are shown",
      prepare: async () => {
        const hub = await oldHub("24");
        hub.d1.sqlite.prepare("DELETE FROM settings WHERE k = 'picture_delay_hours'").run();
        return hub;
      },
      expected: { delay: null, marker: "1", states: ["shown", "shown", "refused", "shown"], dues: NONE },
    },
  ];
}

for (const [how, run] of [["migration 0003", viaMigration], ["the cron's catch-up", viaCatchUp]]) {
  for (const s of scenarios()) {
    Deno.test(`pictures at once: ${how}: ${s.name}`, async () => {
      const hub = await s.prepare();
      await run(hub);
      assertEquals(snapshot(hub), s.expected);
      // Running again changes nothing.
      await run(hub);
      assertEquals(snapshot(hub), s.expected);
    });
  }
}

Deno.test("pictures at once: a delay the owner sets afterwards is never undone, by the migration or by the catch-up", async () => {
  const hub = await oldHub("24");
  await viaMigration(hub);
  assertEquals(snapshot(hub).delay, "0");
  await setDelay(hub, 24);
  seedPackages(hub, 1, () => ({ thumb: thumbB64(), picture: "waiting" }));
  hub.d1.sqlite.prepare("UPDATE packages SET picture_due = ? WHERE picture_state = 'waiting'").run(time() + 5 * 3600);
  const before = snapshot(hub);
  assertEquals(before.delay, "24");
  assertEquals(before.states.filter((x) => x === "waiting").length, 1);
  await viaMigration(hub);
  await viaCatchUp(hub);
  assertEquals((await hub.cron(HOURLY)).pictureCatchUp, { ran: false });
  assertEquals(snapshot(hub), before);
});

Deno.test("pictures at once: the catch-up and the migration agree with whichever came first", async () => {
  // The cron got there first; a late migration then has nothing left to do, even if the owner chose 24 in between.
  const hub = await oldHub("24");
  await viaCatchUp(hub);
  await setDelay(hub, 24);
  const after = snapshot(hub);
  await viaMigration(hub);
  assertEquals(snapshot(hub), after);
  // The other way round.
  const other = await oldHub("24");
  await viaMigration(other);
  other.d1.sqlite.prepare("UPDATE settings SET v = '24' WHERE k = 'picture_delay_hours'").run();
  await viaCatchUp(other);
  assertEquals(snapshot(other).delay, "24");
});

Deno.test("pictures at once: migration 0003 runs on a database that only has 0001 and 0002", async () => {
  const old = new FakeD1();
  old.sqlite.exec(await readMigration("0001_init.sql"));
  old.sqlite.exec(await readMigration("0002_nocturne_plus.sql"));
  assertEquals(old.one("SELECT v FROM settings WHERE k = 'picture_delay_hours'").v, "24");
  assertEquals(old.one("SELECT v FROM settings WHERE k = 'pictures_at_once'"), null);
  old.sqlite.exec(MIGRATION);
  assertEquals(old.one("SELECT v FROM settings WHERE k = 'picture_delay_hours'").v, "0");
  assertEquals(old.one("SELECT v FROM settings WHERE k = 'pictures_at_once'").v, "1");
  old.sqlite.exec(MIGRATION);
  assertEquals(old.one("SELECT count(*) AS n FROM settings WHERE k IN ('picture_delay_hours', 'pictures_at_once')").n, 2);
});

Deno.test("pictures at once: a hub nobody migrated heals itself on the next hourly cron, with no manual step", async () => {
  const hub = await oldHub("24");
  const key = fakeKey(1);
  await register(hub, key);
  // Until the cron runs, the old row still holds a new key's picture back.
  const early = await publish(hub, key, await goodBattle({ title: "Early" }), { thumb: thumbB64() });
  assertEquals(hub.d1.one("SELECT picture_state FROM packages WHERE id = ?", early).picture_state, "waiting");
  assertEquals((await hub.call("GET", `/v1/packages/${early}`)).body.thumb, undefined);
  const first = await hub.cron(HOURLY);
  assertEquals(first.pictureCatchUp, { ran: true, delayReset: 1, shown: 3 });
  advance(61);
  assertEquals(typeof (await hub.call("GET", `/v1/packages/${early}`)).body.thumb, "string");
  assertEquals((await admin(hub, "GET", "settings")).body.settings.picture_delay_hours, "0");
  assertEquals((await admin(hub, "GET", "pictures")).body.items, []);
  // From then on a new key's picture shows the moment its upload finishes.
  const fresh = fakeKey(2);
  await register(hub, fresh, "Two");
  const id = await publish(hub, fresh, await goodBattle({ title: "Later", id: "4f2b8c1e-7d6a-4b5c-9e8f-0a1b2c3d4e5f" }), { thumb: thumbB64({ width: 90 }) });
  assertEquals(hub.d1.one("SELECT picture_state, picture_due FROM packages WHERE id = ?", id), { picture_state: "shown", picture_due: null });
  assertEquals((await hub.cron(HOURLY)).pictureCatchUp, { ran: false });
});

Deno.test("pictures at once: the default is 0 in code and on /admin, and the owner can still set a delay", async () => {
  const hub = await makeHub();
  const settings = await admin(hub, "GET", "settings");
  assertEquals([settings.body.settings.picture_delay_hours, settings.body.defaults.picture_delay_hours], ["0", "0"]);
  assert(!("pictures_at_once" in settings.body.settings), "the marker is not a setting the owner sees");
  assertEquals((await admin(hub, "PUT", "settings", { picture_delay_hours: "8761" })).status, 400);
  await setDelay(hub, 48);
  assertEquals((await admin(hub, "GET", "settings")).body.settings.picture_delay_hours, "48");
  await setDelay(hub, 0);
  assertEquals((await admin(hub, "GET", "settings")).body.settings.picture_delay_hours, "0");
});
