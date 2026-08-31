/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders the ready screen', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({}),
  } as Response);
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  try {
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<App />);
    });
    expect(
      renderer!.root.findByProps({testID: 'e2e-ready-status'}).props.value,
    ).toBe('Ready');
  } finally {
    await ReactTestRenderer.act(async () => renderer?.unmount());
    fetch.mockRestore();
  }
});
