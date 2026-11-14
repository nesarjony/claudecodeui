import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { quickApi, renderForemanApp } from '@/modules/foreman-next/tests/testHelpers';

const openDrawer = async () => {
  await screen.findByText('Running');
  fireEvent.keyDown(window, { key: 'j', metaKey: true });
  return screen.findByRole('complementary', { name: 'Chat with Foreman' });
};

describe('the chat drawer', () => {
  it('opens and closes with ⌘J from any screen, and Ctrl+J does the same', async () => {
    renderForemanApp('/foreman/settings');
    await openDrawer();
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat with Foreman' })).toBeNull());
  });

  it('puts the cursor in the message field, closes on Escape and returns focus to the chat button', async () => {
    renderForemanApp('/foreman');
    const drawer = await openDrawer();
    expect(document.activeElement).toBe(within(drawer).getByLabelText('Message Foreman...'));
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Chat with Foreman' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Chat/ }));
  });

  it('is about the goal on screen, with the conversation, its evidence links and its undoable actions', async () => {
    renderForemanApp('/foreman/work/g-inbox');
    const drawer = await openDrawer();
    expect((within(drawer).getByLabelText('about:') as HTMLSelectElement).value).toBe('goal:g-inbox');
    expect(await within(drawer).findByText('Why did t1 need a second judge round?')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: /decision card/ }).getAttribute('href')).toBe('/foreman/decisions/dec-steer-9');
    expect(within(drawer).getByText('✓ 2 actions')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Undo' }));
    expect(await within(drawer).findByText('Undone')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('is about the run on screen', async () => {
    renderForemanApp('/foreman/work/runs/run-t2');
    const drawer = await openDrawer();
    expect((within(drawer).getByLabelText('about:') as HTMLSelectElement).value).toBe('batch:run-t2');
  });

  it('lets the owner pick another subject and shows its conversation', async () => {
    renderForemanApp('/foreman');
    const drawer = await openDrawer();
    expect(await within(drawer).findByText(/Ask about anything on this screen/)).toBeTruthy();
    fireEvent.change(within(drawer).getByLabelText('about:'), { target: { value: 'goal:g-inbox' } });
    expect(await within(drawer).findByText('Why did t1 need a second judge round?')).toBeTruthy();
  });

  it('sends a message for the next safe point by default and shows the answer', async () => {
    const api = quickApi();
    renderForemanApp('/foreman', api);
    const drawer = await openDrawer();
    const field = within(drawer).getByLabelText('Message Foreman...') as HTMLInputElement;
    const send = within(drawer).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Pause desk tonight' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    expect(await within(drawer).findByText(/Passed on at the next safe point: "Pause desk tonight"/)).toBeTruthy();
    expect(within(drawer).getByText('Pause desk tonight')).toBeTruthy();
    expect(field.value).toBe('');
  });

  it('delivers after the batch when the owner chooses that', async () => {
    renderForemanApp('/foreman');
    const drawer = await openDrawer();
    expect((within(drawer).getByLabelText('next safe point') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(drawer).getByLabelText('after batch'));
    fireEvent.change(within(drawer).getByLabelText('Message Foreman...'), { target: { value: 'Re-plan Contacts' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send' }));
    expect(await within(drawer).findByText(/Queued for after this batch: "Re-plan Contacts"/)).toBeTruthy();
  });

  it('keeps the message and says so when it was not sent', async () => {
    const api = quickApi();
    api.sendChat = async () => {
      throw new Error('down');
    };
    renderForemanApp('/foreman', api);
    const drawer = await openDrawer();
    const field = within(drawer).getByLabelText('Message Foreman...') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Pause' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send' }));
    expect(await within(drawer).findByText('The message was not sent.')).toBeTruthy();
    expect(field.value).toBe('Pause');
  });
});
