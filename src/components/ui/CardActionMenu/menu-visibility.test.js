import test from "node:test";
import assert from "node:assert/strict";
import { menuScrollDistance } from "./menu-visibility.js";

const viewport = { top: 100, left: 0, right: 400, bottom: 800 };
const navigation = {
  top: 700,
  left: 10,
  right: 390,
  bottom: 780,
  width: 380,
  height: 80,
};
const rect = (top, bottom, left = 100, right = 300) => ({
  top,
  bottom,
  left,
  right,
});

test("returns only the distance needed to reveal both the card and menu", () => {
  assert.equal(
    menuScrollDistance(rect(400, 550), rect(558, 650), viewport, navigation),
    0,
  );
  assert.equal(
    menuScrollDistance(rect(80, 180), rect(188, 260), viewport, navigation),
    -20,
  );
  assert.equal(
    menuScrollDistance(rect(580, 650), rect(658, 720), viewport, navigation),
    20,
  );
  assert.equal(
    menuScrollDistance(rect(700, 740), rect(748, 840), viewport, null),
    40,
  );
  assert.equal(
    menuScrollDistance(
      rect(650, 710, 390, 400),
      rect(710, 720, 390, 400),
      viewport,
      navigation,
    ),
    0,
  );
});

test("adds spacing only when scrolling, limited by the available space", () => {
  assert.equal(
    menuScrollDistance(rect(400, 550), rect(558, 650), viewport, navigation, 8),
    0,
  );
  assert.equal(
    menuScrollDistance(rect(80, 180), rect(188, 260), viewport, navigation, 8),
    -28,
  );
  assert.equal(
    menuScrollDistance(rect(580, 650), rect(658, 720), viewport, navigation, 8),
    28,
  );
  assert.equal(
    menuScrollDistance(rect(50, 680), rect(688, 710), viewport, navigation, 8),
    -50,
  );
});
