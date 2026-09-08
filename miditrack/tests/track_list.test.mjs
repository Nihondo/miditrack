import assert from "node:assert/strict";
import test from "node:test";

import { createTrackListController } from "../src/miditrack/web_assets/track_list.mjs";

function createHeader(key) {
  const attributes = new Map();
  const indicator = { textContent: "" };
  return {
    dataset: { sortKey: key },
    indicator,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) || null; },
    querySelector(selector) { return selector === ".sort-indicator" ? indicator : null; },
  };
}

function createButton(key) {
  return {
    dataset: { sortKey: key },
    addEventListener(_type, listener) { this.click = listener; },
  };
}

test("トラック一覧はチャンネル未設定を最後に保ったまま見出し操作で並べ替える", () => {
  const headers = [createHeader("index"), createHeader("channel")];
  const channelButton = createButton("channel");
  let renderCount = 0;
  const controller = createTrackListController({
    locale: "ja",
    getTrackRole: () => "",
    isRoleSortActive: () => false,
    onSortChange: () => { renderCount += 1; },
    queryAll: (selector) => selector === ".sort-button" ? [channelButton] : headers,
  });
  const tracks = [
    { index: 2, channels: [], source: "soundfont", volumePercent: 100 },
    { index: 0, channels: [4], source: "soundfont", volumePercent: 100 },
    { index: 1, channels: [1], source: "soundfont", volumePercent: 100 },
  ];

  controller.connect();
  channelButton.click();
  controller.updateHeaders();

  assert.equal(renderCount, 1);
  assert.deepEqual(controller.sortTracks(tracks).map((track) => track.index), [1, 0, 2]);
  assert.equal(headers[1].getAttribute("aria-sort"), "ascending");
  assert.equal(headers[1].indicator.textContent, "▲");
});

test("編成プリセット中の楽器列は役割名でソートする", () => {
  const roles = { 1: "bass", 2: "melody" };
  const instrumentButton = createButton("instrument");
  const controller = createTrackListController({
    locale: "en",
    getTrackRole: (trackIndex) => roles[trackIndex] || "",
    isRoleSortActive: () => true,
    onSortChange: () => {},
    queryAll: (selector) => selector === ".sort-button" ? [instrumentButton] : [],
  });

  controller.connect();
  instrumentButton.click();
  assert.deepEqual(
    controller.sortTracks([
      { index: 2, channels: [0], source: "soundfont", volumePercent: 100 },
      { index: 1, channels: [1], source: "soundfont", volumePercent: 100 },
    ]).map((track) => track.index),
    [1, 2],
  );
});
