import { expect, it } from "vitest";
import { speedChartMaximum } from "../../src/shared/speed-chart.js";
import { speedSpikes } from "../../src/domain/speed-spikes.js";

const constant = (value: number, count = 20) =>
  Array<number>(count).fill(value);
const times = (values: number[], step = 2000) => values.map((_, i) => i * step);
const detect = (values: number[]) => speedSpikes(values, times(values));

it("detects isolated peaks, consecutive peaks and their declining tails", () => {
  const values = [...constant(122), 809, 296, ...constant(116)];
  const flags = detect(values);
  expect(flags.has(20)).toBe(true);
  expect(flags.has(21)).toBe(true);
  expect(flags.has(10)).toBe(false);
  expect(flags.has(30)).toBe(false);
});

it("handles multi-step recovery with irregular sampling", () => {
  const values = [...constant(40), 69, 512, 227, ...constant(42)];
  const t = times(values);
  for (let i = 20; i < t.length; i++) t[i]! += 53000;
  for (let i = 21; i < t.length; i++) t[i]! += 1000;
  const flags = speedSpikes(values, t);
  expect(flags.has(21)).toBe(true);
  expect(flags.has(22)).toBe(true);
});

it("detects a terminal spike using the available side without requiring recovery", () => {
  const values = [...constant(118), 498, ...constant(114)];
  const t = times(values);
  t[20] = t[19]! + 6000;
  for (let i = 21; i < t.length; i++) t[i] = t[20]! + 157000 + (i - 21) * 2000;
  expect(speedSpikes(values, t).has(20)).toBe(true);
});

it("detects an abnormal tail even when recovery takes more than thirty seconds", () => {
  const values = [...constant(122), 809, 296, ...constant(116)];
  const t = times(values);
  for (let i = 22; i < t.length; i++) t[i]! += 28000;
  const flags = speedSpikes(values, t);
  expect(flags.has(20)).toBe(true);
  expect(flags.has(21)).toBe(true);
});

it("detects local change-rate outliers in an otherwise broad speed distribution", () => {
  const values = Array.from({ length: 100 }, (_, i) => 100 + i * 4);
  values[50]! += 100;
  expect(detect(values).has(50)).toBe(true);
});

it("preserves stable high speeds and smooth acceleration without any speed ceiling", () => {
  expect([...detect(constant(350, 100))]).toEqual([]);
  expect([...detect(constant(900, 100))]).toEqual([]);
  expect([
    ...detect(Array.from({ length: 100 }, (_, i) => 100 + i * 4)),
  ]).toEqual([]);
  const transition = [...constant(100, 100), ...constant(350, 100)];
  expect(detect(transition).has(150)).toBe(false);
});

it("can mark real brief braking or acceleration as statistical outliers", () => {
  const values = [...constant(120), 0, 20, ...constant(120)];
  const flags = detect(values);
  expect(flags.has(20)).toBe(true);
  expect(flags.has(21)).toBe(true);
});

it("does not join context across missing data, reversed times or long gaps", () => {
  const missing = [...constant(10), NaN, ...constant(500)];
  expect([...detect(missing)]).toEqual([]);
  const values = [...constant(10), ...constant(500)];
  for (const breakTime of [NaN, 38000, 37000, 1000000]) {
    const t = times(values);
    for (let i = 20; i < t.length; i++) t[i] = breakTime + (i - 20) * 2000;
    expect([...speedSpikes(values, t)]).toEqual([]);
  }
});

it("handles too little context, stationary data and a zero MAD without rejecting tiny jitter", () => {
  for (const values of [[], [10, 500, 10], constant(0), constant(10)])
    expect([...detect(values)]).toEqual([]);
  const jitter = [...constant(100), 101, ...constant(100)];
  expect([...detect(jitter)]).toEqual([]);
});

it("is scale invariant and does not modify the observations", () => {
  const values = [...constant(10), 100, 40, ...constant(10)];
  const original = [...values];
  expect([...detect(values)].sort((a, b) => a - b)).toEqual(
    [...detect(values.map((v) => v * 100))].sort((a, b) => a - b),
  );
  expect(values).toEqual(original);
});

it("uses time windows even for dense recordings", () => {
  const values = constant(100, 20000);
  values[10000] = 500;
  expect(speedSpikes(values, times(values, 1)).has(10000)).toBe(true);
});

it("only excludes flagged observations from scaling and falls back if all are flagged", () => {
  expect(
    speedChartMaximum([
      { speed: 10 },
      { speed: 500, speed_spike: true },
      { speed: 12 },
    ]),
  ).toBe(12);
  expect(speedChartMaximum([{ speed: 350 }, { speed: 360 }])).toBe(360);
  expect(speedChartMaximum([{ speed: 50, speed_spike: true }])).toBe(50);
  expect(speedChartMaximum([{ speed: null }, { speed: 0 }])).toBe(0);
  expect(speedChartMaximum([])).toBe(0);
});

it("uses nearby in-run context when a spike's time window has fewer than seven neighbors", () => {
  // Irregularly sampled fragment: 48 s before the pair, then a 156 s gap.
  const values = [
    153.97946, 153.13277, 154.49843, 153.51302, 157.17478, 157.28088, 148.64333,
    112.42283, 466.35868, 54.81807, 144.71501, 146.14947, 158.79005, 152.36371,
    153.47338, 154.20686, 140.03057,
  ];
  const t = [
    0, 2, 4, 6, 8, 10, 12, 60, 67, 69, 225, 228, 230, 232, 234, 236, 238,
  ].map((s) => s * 1000);
  const flags = speedSpikes(values, t);
  expect(flags.has(8)).toBe(true);
  expect(flags.has(0)).toBe(false);
  // The later run has insufficient context; it must not borrow across the gap.
  for (let i = 10; i < values.length; i++) expect(flags.has(i)).toBe(false);
});

it("does not borrow across long gaps even when a short run contains a large value", () => {
  const values = [...constant(150), 466, 55, ...constant(150)];
  const t = times(values);
  for (let i = 20; i < t.length; i++) t[i]! += 120000;
  for (let i = 22; i < t.length; i++) t[i]! += 120000;
  expect(speedSpikes(values, t).has(20)).toBe(false);
});
