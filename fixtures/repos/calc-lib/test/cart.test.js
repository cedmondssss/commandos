import assert from 'node:assert/strict';
import test from 'node:test';
import { cartTotal } from '../src/cart.js';

test('cart total with a percentage code', () => {
  assert.equal(cartTotal([{ price: 20, qty: 2 }, { price: 10, qty: 4 }], { percent: 10 }), 72);
});

test('cart total without a code', () => {
  assert.equal(cartTotal([{ price: 3.5, qty: 3 }]), 10.5);
});
