import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDiscount, formatUSD, round2, splitBill } from '../src/money.js';

test('applies fixed-amount discounts', () => {
  assert.equal(applyDiscount(100, { amount: 15 }), 85);
});

test('applies percentage discounts', () => {
  assert.equal(applyDiscount(80, { percent: 25 }), 60);
});

test('never discounts below zero', () => {
  assert.equal(applyDiscount(10, { amount: 50 }), 0);
});

test('splits a bill evenly when it divides', () => {
  assert.deepEqual(splitBill(90, 3), [30, 30, 30]);
});

test('splitting a bill keeps every cent', () => {
  const parts = splitBill(100, 3);
  assert.equal(round2(parts.reduce((a, b) => a + b, 0)), 100);
  assert.deepEqual(parts, [33.34, 33.33, 33.33]);
});

test('formats US dollars', () => {
  assert.equal(formatUSD(1234.5), '$1,234.50');
});
