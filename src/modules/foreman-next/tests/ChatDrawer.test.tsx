import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(await within(drawer).findByText('Why did t1 need a second judge round?')).toBeTruthy();
    expect((within(drawer).getByLabelText('about:') as HTMLSelectElement).value).toBe('g-inbox');
    expect(await within(drawer).findByText('Why did t1 need a second judge round?')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: /decision card/ }).getAttribute('href')).toBe('/foreman/decisions/dec-steer-9');
    expect(within(drawer).getByText('✓ 2 actions')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Undo' }));
    expect(await within(drawer).findByText('Undone')).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('keeps the conversation of the run\'s goal when the screen is a run, and says what it is looking at', async () => {
    renderForemanApp('/foreman/work/runs/run-t2');
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Why did t1 need a second judge round?')).toBeTruthy();
    expect((within(drawer).getByLabelText('about:') as HTMLSelectElement).value).toBe('g-inbox');
    expect(within(drawer).getByText('Looking at: t2-layout')).toBeTruthy();
  });

  it('keeps the conversation of the decision\'s goal when the screen is a decision card', async () => {
    renderForemanApp('/foreman/decisions/dec-steer-9');
    const drawer = await openDrawer();
    expect(await within(drawer).findByText('Looking at: Steer at turn 9 · t2-layout')).toBeTruthy();
    expect((within(drawer).getByLabelText('about:') as HTMLSelectElement).value).toBe('g-inbox');
  });

  it('asks Foreman for the thread of the screen\'s subject once, and not the goal, run or decision itself', async () => {
    const api = quickApi();
    const thread = vi.spyOn(api, 'chatThread');
    const goal = vi.spyOn(api, 'goal');
    const decision = vi.spyOn(api, 'decision');
    renderForemanApp('/foreman/work/runs/run-t2', api);
    const drawer = await openDrawer();
    await within(drawer).findByText('Looking at: t2-layout');
    expect(thread).toHaveBeenCalledWith({ kind: 'run', id: 'run-t2' });
    expect(goal).not.toHaveBeenCalled();
    expect(decision).not.toHaveBeenCalled();
  });

  it('sends the screen as the subject of the message', async () => {
    const api = quickApi();
    const send = vi.spyOn(api, 'sendChat');
    renderForemanApp('/foreman/work/runs/run-t2', api);
    const drawer = await openDrawer();
    await within(drawer).findByText('Why did t1 need a second judge round?');
    fireEvent.change(within(drawer).getByLabelText('Message Foreman...'), { target: { value: 'Pause after this' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith({ subject: { kind: 'run', id: 'run-t2' }, text: 'Pause after this', delivery: 'next-safe-point' });
  });

  it('lets the owner pick another goal and shows its conversation', async () => {
    renderForemanApp('/foreman');
    const drawer = await openDrawer();
    expect(await within(drawer).findByText(/Ask about anything on this screen/)).toBeTruthy();
    expect(Array.from((within(drawer).getByLabelText('about:') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(['Foreman', 'desk · Inbox', 'desk · Contacts']);
    fireEvent.change(within(drawer).getByLabelText('about:'), { target: { value: 'g-inbox' } });
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
    expect(await within(drawer).findByText('That did not work. Try again.')).toBeTruthy();
    expect(field.value).toBe('Pause');
  });

  it('remembers an answer of Foreman as knowledge, once', async () => {
    const api = quickApi();
    const remember = vi.spyOn(api, 'rememberChatMessage');
    renderForemanApp('/foreman/work/g-inbox', api);
    const drawer = await openDrawer();
    await within(drawer).findByText('Why did t1 need a second judge round?');
    expect(within(drawer).getAllByRole('button', { name: 'Remember' })).toHaveLength(2);
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Remember' })[0] as HTMLElement);
    expect(await within(drawer).findByText('Remembered as knowledge')).toBeTruthy();
    expect(remember).toHaveBeenCalledWith('m2');
    expect(within(drawer).getAllByRole('button', { name: 'Remember' })).toHaveLength(1);
  });
});

describe('the chat drawer on a narrow screen', () => {
  const widthBefore = window.innerWidth;
  afterEach(() => {
    window.innerWidth = widthBefore;
  });

  const openNarrow = async () => {
    window.innerWidth = 700;
    renderForemanApp('/foreman');
    return openDrawer();
  };

  it('keeps Tab inside the drawer: from the last control (the chosen delivery, as unchosen radios are skipped) to the first, and Shift+Tab the other way', async () => {
    const drawer = await openNarrow();
    const first = within(drawer).getByLabelText('about:');
    const last = within(drawer).getByLabelText('next safe point');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('brings focus back inside when it has left the drawer', async () => {
    const drawer = await openNarrow();
    screen.getByRole('link', { name: 'Work' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it('leaves Tab alone on a wide screen, where the drawer is a column beside the page', async () => {
    window.innerWidth = 1400;
    renderForemanApp('/foreman');
    const drawer = await openDrawer();
    const link = screen.getByRole('link', { name: 'Work' });
    link.focus();
    const prevented = !fireEvent.keyDown(document, { key: 'Tab' });
    expect(prevented).toBe(false);
    expect(drawer.contains(document.activeElement)).toBe(false);
  });
});
