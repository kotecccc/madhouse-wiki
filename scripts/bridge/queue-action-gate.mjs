import { INVENTORY_ACTION_TYPES } from "../automation/inventory-actions.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

/** In-process permission for one already-persisted queue attempt. */
export function createQueueActionGate() {
  const storage = new AsyncLocalStorage();
  return Object.freeze({
    capture() {
      const context = storage.getStore();
      return (callback) =>
        context ? storage.run(context, callback) : callback();
    },
    async runWork(permit, callback) {
      if (typeof permit !== "function" || typeof callback !== "function")
        throw new TypeError("work_permit_required");
      const context = { workPermit: permit, active: true };
      try {
        return await storage.run(context, callback);
      } finally {
        context.active = false;
      }
    },
    async run(
      job,
      reconcile,
      authorization,
      callback,
      canDispatch,
      checkpoint,
    ) {
      if (typeof callback !== "function")
        throw new TypeError("callback_required");
      const context = {
        job,
        reconcile,
        authorization,
        canDispatch,
        checkpoint,
        active: true,
        used: false,
      };
      try {
        return await storage.run(context, callback);
      } finally {
        context.active = false;
      }
    },
    claim({ authorization, method, path, body }) {
      const context = storage.getStore();
      if (context?.active && typeof context.workPermit === "function")
        return (
          context.workPermit({ authorization, method, path, body }) === true
        );
      if (context?.job?.type === "invitation.accept") {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          method !== "POST" ||
          typeof body !== "string" ||
          body.length > 512 ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let value, pending;
        try {
          value = JSON.parse(body);
          pending = context.checkpoint();
        } catch {
          return false;
        }
        if (
          !value ||
          Object.keys(value).join(",") !== "operationId" ||
          path !== `/api/bosses/invitations/${job.args?.invitationId}/accept` ||
          pending?.id !== job.id ||
          pending.kind !== "invitation" ||
          pending.invitationId !== job.args?.invitationId ||
          pending.battleId !== job.args?.battleId ||
          pending.bossId !== job.args?.bossId ||
          typeof pending.operationId !== "string" ||
          !pending.operationId ||
          value.operationId !== pending.operationId
        )
          return false;
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      if (context?.job?.type === "stash.craft") {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          method !== "POST" ||
          path !== "/api/stash/craft" ||
          typeof body !== "string" ||
          body.length > 512 ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let value, pending;
        try {
          value = JSON.parse(body);
          pending = context.checkpoint();
        } catch {
          return false;
        }
        if (
          !value ||
          Object.keys(value).sort().join(",") !== "operationId,setId" ||
          pending?.id !== job.id ||
          pending.setId !== job.args?.setId ||
          value.setId !== pending.setId ||
          typeof pending.operationId !== "string" ||
          !pending.operationId ||
          value.operationId !== pending.operationId
        )
          return false;
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      if (["battle.heal", "battle.buy"].includes(context?.job?.type)) {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          method !== "POST" ||
          typeof body !== "string" ||
          body.length > 512 ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let value, pending;
        try {
          value = JSON.parse(body);
          pending = context.checkpoint();
        } catch {
          return false;
        }
        if (
          !value ||
          pending?.queueId !== job.id ||
          pending.battleId !== job.args?.battleId ||
          value.operationId !== pending.operationId ||
          typeof value.operationId !== "string" ||
          !value.operationId
        )
          return false;
        if (job.type === "battle.heal") {
          if (
            pending.kind !== "heal" ||
            path !== `/api/bosses/battles/${job.args.battleId}/items/use` ||
            Object.keys(value).sort().join(",") !== "operationId,type" ||
            value.type !== job.args.type ||
            pending.type !== value.type
          )
            return false;
        } else {
          const q = job.args.quote;
          if (
            pending.kind !== "buy" ||
            path !== "/api/me/bag/combat-items/buy" ||
            Object.keys(value).sort().join(",") !==
              "currency,operationId,quantity,type" ||
            !q ||
            value.type !== q.type ||
            value.currency !== q.currency ||
            value.quantity !== q.quantity ||
            pending.quote?.type !== q.type ||
            pending.quote?.currency !== q.currency ||
            pending.quote?.quantity !== q.quantity ||
            pending.quote?.total !== q.total
          )
            return false;
        }
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      if (["battle.start", "battle.attack"].includes(context?.job?.type)) {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          method !== "POST" ||
          typeof body !== "string" ||
          body.length > 512 ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let value, pending;
        try {
          value = JSON.parse(body);
          pending = context.checkpoint();
        } catch {
          return false;
        }
        const expected =
          job.type === "battle.start"
            ? `/api/bosses/${job.args?.bossId}/battles`
            : `/api/bosses/battles/${job.args?.battleId}/attack`;
        if (
          path !== expected ||
          pending?.id !== job.id ||
          pending.bossId !== job.args?.bossId ||
          (job.type === "battle.attack" &&
            (pending.kind !== "attack" ||
              pending.battleId !== job.args?.battleId)) ||
          !value ||
          Object.keys(value).join(",") !== "operationId" ||
          typeof value.operationId !== "string" ||
          !value.operationId ||
          value.operationId !== pending.operationId
        )
          return false;
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      if (context?.job?.type === "inventory") {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let pending;
        try {
          pending = context.checkpoint();
        } catch {
          return false;
        }
        const a = job.args,
          def = INVENTORY_ACTION_TYPES[a?.type];
        if (
          !def ||
          pending?.id !== job.id ||
          pending.type !== a.type ||
          pending.entityId !== a.id ||
          pending.action !== a.action ||
          (pending.zoneId ?? null) !== (a.zoneId ?? null)
        )
          return false;
        const expectedPath =
          a.action === "buy"
            ? def.buy
            : a.action === "repair"
              ? "/api/weapons/repair"
              : a.action === "equip"
                ? def.equip
                : a.action === "unequip" && def.remove
                  ? def.remove.endsWith("/")
                    ? def.remove + a.id
                    : def.remove
                  : null;
        const expectedMethod = ["buy", "repair"].includes(a.action)
          ? "POST"
          : a.action === "unequip"
            ? "DELETE"
            : def.method;
        if (!expectedPath || method !== expectedMethod || path !== expectedPath)
          return false;
        if (a.action === "unequip") {
          if (body != null) return false;
        } else {
          let value;
          try {
            if (typeof body !== "string" || body.length > 512) return false;
            value = JSON.parse(body);
          } catch {
            return false;
          }
          const keys = pending.operationId
            ? [def.id, "operationId"].sort().join(",")
            : def.id;
          if (
            !value ||
            Object.keys(value).sort().join(",") !== keys ||
            value[def.id] !== a.id ||
            (pending.operationId && value.operationId !== pending.operationId)
          )
            return false;
        }
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      if (context?.job?.type === "energy.booster") {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          method !== "POST" ||
          !["/api/me/bag/boosters/use", "/api/me/bag/boosters/buy"].includes(
            path,
          ) ||
          typeof body !== "string" ||
          body.length > 512 ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let value, pending;
        try {
          value = JSON.parse(body);
          pending = context.checkpoint();
        } catch {
          return false;
        }
        const buying = path.endsWith("/buy");
        if (
          !value ||
          pending?.id !== job.id ||
          pending.type !== job.args?.type ||
          value.type !== pending.type ||
          !["small", "full"].includes(value.type) ||
          (buying
            ? pending.phase !== "buying" ||
              Object.keys(value).sort().join(",") !==
                "operationId,quantity,type" ||
              value.quantity !== 1 ||
              value.operationId !== pending.operationId
            : pending.phase !== "using" ||
              Object.keys(value).join(",") !== "type")
        )
          return false;
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      if (context?.job?.type === "friend.request") {
        const job = context.job;
        if (
          !context.active ||
          context.used ||
          context.reconcile ||
          job.status !== "running" ||
          !job.id ||
          authorization !== context.authorization ||
          method !== "POST" ||
          path !== "/api/friends/requests" ||
          typeof body !== "string" ||
          body.length > 128 ||
          typeof context.canDispatch !== "function" ||
          typeof context.checkpoint !== "function"
        )
          return false;
        let value, pending;
        try {
          value = JSON.parse(body);
          pending = context.checkpoint();
        } catch {
          return false;
        }
        if (
          !value ||
          Object.keys(value).length !== 1 ||
          !Number.isSafeInteger(value.playerId) ||
          value.playerId <= 0 ||
          pending?.id !== job.id ||
          pending.playerId !== value.playerId ||
          (job.args?.playerId != null && job.args.playerId !== value.playerId)
        )
          return false;
        try {
          if (context.canDispatch() !== true) return false;
        } catch {
          return false;
        }
        context.used = true;
        return true;
      }
      const job = context?.job;
      if (
        !context?.active ||
        context.used ||
        context.reconcile ||
        typeof context.canDispatch !== "function" ||
        typeof authorization !== "string" ||
        authorization !== context.authorization ||
        !["friend.response", "friend.remove"].includes(job?.type) ||
        job.status !== "running" ||
        typeof job.id !== "string" ||
        !job.id ||
        !Number.isSafeInteger(job.args?.playerId) ||
        job.args.playerId <= 0 ||
        (job.type === "friend.response" &&
          !["accept", "decline"].includes(job.args.decision))
      )
        return false;
      const accept =
        job.type === "friend.response" && job.args.decision === "accept";
      const expectedPath =
        job.type === "friend.remove"
          ? `/api/friends/${job.args.playerId}`
          : `/api/friends/requests/${job.args.playerId}${accept ? "/accept" : ""}`;
      if (path !== expectedPath || method !== (accept ? "POST" : "DELETE"))
        return false;
      try {
        if (context.canDispatch() !== true) return false;
      } catch {
        return false;
      }
      context.used = true;
      return true;
    },
  });
}
