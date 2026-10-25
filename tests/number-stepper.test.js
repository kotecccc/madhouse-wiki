import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("NumberStepper optionally renders a guarded MAX button", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const { NumberStepper } = await server.ssrLoadModule(
      "/src/components/ui/NumberStepper/NumberStepper.jsx",
    );
    const render = (props) =>
      renderToStaticMarkup(
        createElement(NumberStepper, {
          id: "count",
          label: "Количество",
          value: 2,
          min: 1,
          max: 5,
          onChange() {},
          ...props,
        }),
      );

    const defaultMarkup = render({});
    assert.ok(!defaultMarkup.includes(">MAX</button>"));
    assert.ok(defaultMarkup.includes('class="number-stepper-manual"'));
    assert.ok(!defaultMarkup.includes("number-stepper-controls--max"));

    const enabledMarkup = render({ showMaxButton: true });
    assert.ok(
      enabledMarkup.includes('aria-label="Установить максимальное количество"'),
    );
    assert.ok(enabledMarkup.includes(">MAX</button>"));
    assert.ok(enabledMarkup.includes("number-stepper-controls--max"));
    assert.ok(enabledMarkup.includes('class="number-stepper-manual"'));
    assert.ok(
      !enabledMarkup.includes(
        'disabled="" aria-label="Установить максимальное количество"',
      ),
    );

    const atMaxMarkup = render({ showMaxButton: true, value: 5 });
    assert.match(
      atMaxMarkup,
      /disabled="" aria-label="Установить максимальное количество"/,
    );

    const unsafeMaxMarkup = render({
      showMaxButton: true,
      max: Number.MAX_SAFE_INTEGER + 1,
    });
    assert.match(
      unsafeMaxMarkup,
      /disabled="" aria-label="Установить максимальное количество"/,
    );

    const toggleMarkup = render({
      maxToggle: {
        active: true,
        onToggle() {},
        disabled: false,
        label: "До лимита",
      },
    });
    assert.ok(toggleMarkup.includes('class="button button-toggle'));
    assert.ok(toggleMarkup.includes('aria-pressed="true"'));
    assert.ok(toggleMarkup.includes(">До лимита</button>"));
    assert.equal((toggleMarkup.match(/disabled=""/g) || []).length, 3);

    const disabledToggleMarkup = render({
      maxToggle: { active: false, onToggle() {}, disabled: true },
      disabled: true,
    });
    assert.ok(disabledToggleMarkup.includes('aria-pressed="false"'));
    assert.equal((disabledToggleMarkup.match(/disabled=""/g) || []).length, 4);
    assert.ok(disabledToggleMarkup.includes(">MAX</button>"));
  } finally {
    await server.close();
  }
});
