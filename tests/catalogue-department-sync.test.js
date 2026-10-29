import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCatalogueSyncApi } from "../scripts/catalogue/sync-api.mjs";

const root = process.cwd();
const authorization = `Bearer ${"x".repeat(24)}`;
function fixture({ unlocked = true, workId = 30 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "catalogue-department-"));
  const file = join(directory, "catalogue.sqlite");
  copyFileSync(join(root, "local-data/madhouse.sqlite"), file);
  const calls = [];
  let updated;
  const api = createCatalogueSyncApi({
    root,
    storeBlob: { download: async () => ({ file, mutable: true }) },
    onCatalogue: (model) => {
      updated = model;
    },
    fetcher: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push([path, options.method, options.body]);
      if (path === "/api/floors")
        return Response.json([{ code: "J", isAvailable: true }]);
      if (path === "/api/floors/J/info")
        return Response.json({
          floorCode: "J",
          departments: [{ blockCode: "J3", unlocked, current: 999 }],
        });
      if (path === "/api/works/open")
        return Response.json({
          workId,
          title: "Test work",
          tasks: [
            { id: 1, title: "Task", energyCost: 10, required: 2, current: 999 },
          ],
          completed: 999,
        });
      throw new Error(`unexpected route ${path}`);
    },
  });
  const request = () =>
    api(
      new Request("https://wiki.example/api/catalogue", {
        method: "POST",
        headers: { authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ floorCode: "J", departmentCode: "J3" }),
      }),
    );
  return { directory, file, calls, request, updated: () => updated };
}

test("an unlocked department captures its missing work and updates the public model", async () => {
  const f = fixture();
  try {
    const response = await f.request();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.catalogue.departments.find((d) => d.code === "J3").work.title,
      "Test work",
    );
    assert.equal(
      f.updated().works.find((w) => w.workId === 30).title,
      "Test work",
    );
    assert.deepEqual(
      f.calls.map(([path]) => path),
      ["/api/floors", "/api/floors/J/info", "/api/works/open"],
    );
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "select data_json from entities where kind='work' and api_id='30'",
        )
        .get();
      assert.equal(
        JSON.stringify(JSON.parse(row.data_json)).includes("999"),
        false,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("locked departments do not trigger a work read", async () => {
  const f = fixture({ unlocked: false });
  try {
    assert.equal((await f.request()).status, 403);
    assert.deepEqual(
      f.calls.map(([path]) => path),
      ["/api/floors", "/api/floors/J/info"],
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a mismatched work response is never saved under the requested route", async () => {
  const f = fixture({ workId: 31 });
  try {
    await f.request();
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare("select status from captures where path=?")
          .get("/api/works/open?workId=30").status,
        502,
      );
      assert.equal(
        db
          .prepare("select 1 from entities where kind='work' and api_id='30'")
          .get(),
        undefined,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a captured work is persisted in shared storage for later readers", async () => {
  const f = fixture();
  const savedFile = join(f.directory, "shared.sqlite");
  copyFileSync(f.file, savedFile);
  let uploads = 0;
  const storeBlob = {
    async download() {
      const directory = mkdtempSync(join(tmpdir(), "catalogue-download-"));
      const file = join(directory, "catalogue.sqlite");
      copyFileSync(savedFile, file);
      return { directory, file, etag: '"version"' };
    },
    async upload(file, etag) {
      assert.equal(etag, '"version"');
      copyFileSync(file, savedFile);
      uploads++;
    },
  };
  const api = createCatalogueSyncApi({
    root,
    storeBlob,
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/floors")
        return Response.json([{ code: "J", isAvailable: true }]);
      if (path === "/api/floors/J/info")
        return Response.json({
          departments: [{ blockCode: "J3", unlocked: true }],
        });
      if (path === "/api/works/open")
        return Response.json({ workId: 30, title: "Shared work", tasks: [] });
      throw new Error("unexpected request");
    },
  });
  try {
    const response = await api(
      new Request("https://wiki.example/api/catalogue", {
        method: "POST",
        headers: { authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ floorCode: "J", departmentCode: "J3" }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(uploads, 1);
    const later = await api(new Request("https://wiki.example/api/catalogue"));
    const body = await later.json();
    assert.equal(
      body.departments.find((d) => d.code === "J3").work.title,
      "Shared work",
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("missing boss and business routes are exposed and collected only for an unlocked department", async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.file);
    db.prepare("DELETE FROM captures WHERE path IN (?, ?)").run(
      "/api/bosses/59",
      "/api/businesses/59",
    );
    db.close();
    const calls = [];
    const api = createCatalogueSyncApi({
      root,
      storeBlob: { download: async () => ({ file: f.file, mutable: true }) },
      fetcher: async (url) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === "/api/floors")
          return Response.json([{ code: "J", isAvailable: true }]);
        if (path === "/api/floors/J/info")
          return Response.json({
            departments: [
              { blockCode: "J3", unlocked: true },
              { blockCode: "J4", unlocked: false },
            ],
          });
        if (path === "/api/bosses/59")
          return Response.json({
            id: 59,
            nameRu: "Boss reference",
            owned: true,
          });
        if (path === "/api/businesses/59")
          return Response.json({
            id: 59,
            name: "Business reference",
            level: 999,
          });
        throw new Error(`unexpected ${path}`);
      },
    });
    const initial = await (
      await api(new Request("https://wiki.example/api/catalogue"))
    ).json();
    assert.ok(
      initial.pendingRoutes.some(
        (r) => r.departmentCode === "J3" && r.kind === "boss" && r.id === 59,
      ),
    );
    assert.ok(
      initial.pendingRoutes.some(
        (r) =>
          r.departmentCode === "J3" && r.kind === "business" && r.id === 59,
      ),
    );
    const send = (payload) =>
      api(
        new Request("https://wiki.example/api/catalogue", {
          method: "POST",
          headers: { authorization, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    for (const kind of ["boss", "business"]) {
      const response = await send({
        floorCode: "J",
        departmentCode: "J3",
        kind,
        id: 59,
      });
      assert.equal(response.status, 200);
    }
    const count = calls.length;
    assert.equal(
      (
        await send({
          floorCode: "J",
          departmentCode: "J3",
          kind: "boss",
          id: 59,
        })
      ).status,
      200,
    );
    assert.equal(calls.slice(count).includes("/api/bosses/59"), false);
    assert.equal(
      (
        await send({
          floorCode: "J",
          departmentCode: "J4",
          kind: "boss",
          id: 59,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send({
          floorCode: "J",
          departmentCode: "J3",
          kind: "boss",
          id: 999999,
        })
      ).status,
      404,
    );
    const stored = new DatabaseSync(f.file, { readOnly: true });
    try {
      const rows = stored
        .prepare(
          "SELECT data_json FROM entities WHERE api_id='59' AND kind IN ('boss','business')",
        )
        .all();
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every(
          ({ data_json }) =>
            !data_json.includes('"owned"') && !data_json.includes('"level"'),
        ),
      );
    } finally {
      stored.close();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("opened department responses do not erase previously recorded opening requirements", async () => {
  const { CatalogueStore } = await import("../scripts/catalogue/store.mjs");
  const f = fixture();
  try {
    const store = new CatalogueStore(root, f.file);
    store.capture("/api/floors/J/info", 200, {
      departments: [
        {
          blockCode: "J3",
          unlocked: false,
          requirements: [
            { type: "work_completions", required: 10, workId: 29 },
          ],
        },
      ],
    });
    store.capture("/api/floors/J/info", 200, {
      departments: [{ blockCode: "J3", unlocked: true, requirements: [] }],
    });
    const rules = store.db
      .prepare(
        "SELECT count(*) AS count FROM entity_links WHERE from_kind='department' AND from_id='dept-J3' AND relation='requires'",
      )
      .get();
    assert.equal(rules.count, 1);
    store.close();
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a missing floor is discovered from floor access and its info is saved without querying locked entities", async () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.file);
    db.prepare("DELETE FROM captures WHERE path=?").run("/api/floors/J/info");
    db.close();
    const api = createCatalogueSyncApi({
      root,
      storeBlob: { download: async () => ({ file: f.file, mutable: true }) },
      fetcher: async (url) => {
        const path = new URL(url).pathname;
        if (path === "/api/floors")
          return Response.json([{ code: "J", isAvailable: true, number: 10 }]);
        if (path === "/api/floors/J/info")
          return Response.json({
            departments: [
              { blockCode: "J3", unlocked: false, name: "Recorded department" },
            ],
          });
        throw new Error(`unexpected entity request ${path}`);
      },
    });
    const initial = await (
      await api(new Request("https://wiki.example/api/catalogue"))
    ).json();
    assert.ok(initial.missingFloorInfo.includes("J"));
    const response = await api(
      new Request("https://wiki.example/api/catalogue", {
        method: "POST",
        headers: { authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ floorCode: "J", floorInfo: true }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).catalogue.departments.find(
        (department) => department.code === "J3",
      ).name,
      "Recorded department",
    );
    const after = await (
      await api(new Request("https://wiki.example/api/catalogue"))
    ).json();
    assert.equal(after.missingFloorInfo.includes("J"), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
