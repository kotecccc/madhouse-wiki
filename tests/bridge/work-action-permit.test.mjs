import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkActionPermit } from "../../scripts/bridge/work-action-permit.mjs";

test("work permit matches the checkpoint, account and exact request once", () => {
  let active = true;
  const claim = createWorkActionPermit({
    authorization: "Bearer test",
    workId: 7,
    taskId: 2,
    operationId: "op-1",
    checkpointIsCurrent: () => active,
  });
  const request = {
    authorization: "Bearer test",
    method: "POST",
    path: "/api/works/tasks/perform",
    body: JSON.stringify({
      workId: 7,
      taskId: 2,
      locale: "ru",
      operationId: "op-1",
    }),
  };
  assert.equal(claim({ ...request, authorization: "Bearer other" }), false);
  assert.equal(
    claim({
      ...request,
      body: JSON.stringify({
        workId: 7,
        taskId: 3,
        locale: "ru",
        operationId: "op-1",
      }),
    }),
    false,
  );
  active = false;
  assert.equal(claim(request), false);
  active = true;
  assert.equal(claim(request), true);
  assert.equal(claim(request), false);
});
